import { describe, expect, it, vi } from "vitest";

import {
  EncryptionNotConfiguredError,
  McpConnectionService,
} from "../../../src/modules/externalSkills/services/mcpConnectionService.js";
import type { FetchLike } from "../../../src/modules/externalSkills/oauth/oauthClient.js";
import type { ToolServiceFactory } from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";
import {
  InMemoryMcpConnectionRepository,
  createMockToolServiceFactory,
} from "../../support/inMemoryExternalSkills.js";

const encryptionKey = Buffer.alloc(32, 3).toString("base64");

const oauthInput = {
  displayName: "Scheduler",
  serverUrl: "https://mcp.example.com",
  authMethod: "oauth" as const,
  oauth: {
    authorizationEndpoint: "https://auth.example.com/authorize",
    tokenEndpoint: "https://auth.example.com/token",
    clientId: "client-123",
    clientSecret: "shh",
    scopes: ["read"],
  },
};
const baseInput = {
  displayName: "Slack",
  serverUrl: "https://mcp.example.com",
  authMethod: "access_token" as const,
  accessToken: "tok",
};

describe("McpConnectionService (unit)", () => {
  it("rejects a connection whose URL fails the SSRF guard", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      encryptionKey,
      assertPublicUrl: (url) => {
        if (url.includes("127.0.0.1") || url.includes(".internal")) {
          throw new Error("non-public host");
        }
      },
    });

    await expect(service.create("agent-1", { ...baseInput, serverUrl: "https://127.0.0.1:8443" })).rejects.toThrow();
    // A public host passes the guard.
    await expect(service.create("agent-1", baseInput)).resolves.toMatchObject({ status: "authorized" });
  });

  it("fails with a 503 AppError when encryption is not configured", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      // no encryptionKey
    });

    await expect(service.create("agent-1", baseInput)).rejects.toBeInstanceOf(EncryptionNotConfiguredError);
    await expect(service.create("agent-1", baseInput)).rejects.toMatchObject({ statusCode: 503 });
  });

  it("creates an OAuth connection as unconfigured and runs the full consent flow to authorized", async () => {
    const repository = new InMemoryMcpConnectionRepository();
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      }),
    );
    const service = new McpConnectionService({
      repository,
      toolServiceFactory: createMockToolServiceFactory(),
      encryptionKey,
      oauthRedirectUri: "https://app.example.com/oauth/mcp-callback",
      fetchImpl,
    });

    const created = await service.create("agent-1", oauthInput);
    expect(created).toMatchObject({ authMethod: "oauth", status: "unconfigured", hasCredential: false });

    const { authorizationUrl } = await service.startOauthAuthorization("agent-1", created.id);
    const authUrl = new URL(authorizationUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://auth.example.com/authorize");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl.searchParams.get("state")!;
    expect(state).toBeTruthy();

    const completed = await service.completeOauthAuthorization("agent-1", created.id, "auth-code", state);
    expect(completed).toMatchObject({ status: "authorized", hasCredential: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an OAuth callback whose state does not match", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      encryptionKey,
      oauthRedirectUri: "https://app.example.com/oauth/mcp-callback",
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: "x" }) }),
    });
    const created = await service.create("agent-1", oauthInput);
    await service.startOauthAuthorization("agent-1", created.id);

    await expect(
      service.completeOauthAuthorization("agent-1", created.id, "auth-code", "wrong-state"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects access-token rotation on OAuth connections", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      encryptionKey,
      oauthRedirectUri: "https://app.example.com/oauth/mcp-callback",
    });
    const created = await service.create("agent-1", oauthInput);

    await expect(
      service.update("agent-1", created.id, { accessToken: "raw-token" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("uses OAuth bearer credentials when discovering tools", async () => {
    const repository = new InMemoryMcpConnectionRepository();
    const fetchImpl = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
      }),
    );
    const discoveredTokens: string[] = [];
    const toolServiceFactory: ToolServiceFactory = {
      create: (connection) => ({
        listTools: async () => {
          const token = await connection.oauthAccessTokenProvider?.();
          if (token) {
            discoveredTokens.push(token);
          }
          return [{ name: "oauth_tool" }];
        },
      } as never),
    };
    const service = new McpConnectionService({
      repository,
      toolServiceFactory,
      encryptionKey,
      oauthRedirectUri: "https://app.example.com/oauth/mcp-callback",
      fetchImpl,
    });
    const created = await service.create("agent-1", oauthInput);
    const { authorizationUrl } = await service.startOauthAuthorization("agent-1", created.id);
    const state = new URL(authorizationUrl).searchParams.get("state")!;
    await service.completeOauthAuthorization("agent-1", created.id, "auth-code", state);

    await expect(service.discoverTools("agent-1", created.id)).resolves.toEqual([{ name: "oauth_tool" }]);
    expect(discoveredTokens).toEqual(["at-1"]);
  });

  it("never returns OAuth secrets in the connection summary", async () => {
    const service = new McpConnectionService({
      repository: new InMemoryMcpConnectionRepository(),
      toolServiceFactory: createMockToolServiceFactory(),
      encryptionKey,
      oauthRedirectUri: "https://app.example.com/oauth/mcp-callback",
    });
    const created = await service.create("agent-1", oauthInput);
    const summary = JSON.stringify(created);
    expect(summary).not.toContain("shh");
    expect(summary).not.toContain("client-123");
  });
});
