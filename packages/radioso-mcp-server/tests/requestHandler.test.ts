import { describe, expect, it, vi } from "vitest";

import { createAuditLogger } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { hashToken } from "../src/auth/token.js";
import { createMcpRequestHandler } from "../src/http/requestHandler.js";
import { createMcpHttpRuntime } from "../src/http/publicRuntime.js";
import { createSessionMcpServerManager } from "../src/http/sessionServerManager.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";
import { createRuntimeStoreReadiness } from "../src/state/runtimeStores.js";

const config = {
  accessTokenTtlSeconds: 900,
  allowedReadTools: ["describe_capabilities", "list_documents"],
  allowedWriteTools: ["create_document"],
  approvalRequiredWriteTools: ["create_document"],
  baseUrl: "http://radioso.test",
  bindHost: "127.0.0.1",
  bindPort: 0,
  requestTimeoutMs: 30_000,
  serverName: "radioso-test",
  signingSecret: "dev-signing-secret",
};

const createHandler = async () => {
  const auditLogger = createAuditLogger([]);
  const policy = createCapabilityPolicyRegistry({
    allowedReadTools: config.allowedReadTools,
    allowedWriteTools: config.allowedWriteTools,
    approvalRequiredWriteTools: config.approvalRequiredWriteTools,
  });
  const authService = createAuthService({
    auditLogger,
    policy,
    sessionStore: createInMemorySessionStore(),
    signingSecret: config.signingSecret,
    validateWorkspaceToken: async () => ({
      apiVersion: "0.1.0",
      mcpContextVersion: "2026-05-06",
      supportedTools: ["describe_capabilities", "list_documents", "create_document"],
      workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
      workspaceName: "Default",
    }),
  });
  const exchanged = await authService.exchangeWorkspaceToken({
    radiosoApiToken: "radioso_test",
    requestedTools: ["describe_capabilities", "list_documents"],
  });
  const serverManager = createSessionMcpServerManager({
    auditLogger,
    config,
  });

  return {
    exchanged,
    handler: createMcpRequestHandler({
      config,
      serverManager,
      verifyBearerToken: (token) => authService.getSession(token),
    }),
  };
};

const request = (accessToken: string | null, payload: unknown) =>
  new Request("http://127.0.0.1/mcp", {
    body: JSON.stringify(payload),
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    method: "POST",
  });

describe("MCP request handler", () => {
  it.each(["personal_api", "service_account_credential"] as const)(
    "rejects a %s credential from the merged runtime verifier",
    async (credentialClass) => {
      const runtime = await createMcpHttpRuntime({
        auditSinks: [],
        config,
        verifyBearerToken: async () => ({
          credentialClass,
          upstreamApiToken: "new-credential",
          workspaceId: "workspace-1",
        }),
      });

      try {
        await runtime.readiness.waitUntilReady();
        const response = await runtime.handler(request("new-credential", {
          id: "1",
          jsonrpc: "2.0",
          method: "tools/list",
          params: {},
        }));

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toMatchObject({
          error: {
            code: -32001,
            data: { code: "invalid_access_token" },
          },
        });
      } finally {
        await runtime.close();
      }
    },
  );

  it("fails closed until runtime-store purge readiness is established", async () => {
    const verifyBearerToken = vi.fn(async () => null);
    const readiness = createRuntimeStoreReadiness({
      purge: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("Redis unavailable")),
      retryDelayMs: 50,
    });
    const handler = createMcpRequestHandler({
      config,
      readiness,
      serverManager: createSessionMcpServerManager({ config }),
      verifyBearerToken,
    });
    readiness.start();

    const response = await handler(request("unavailable", {
      id: "1",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32002,
        data: { code: "mcp_runtime_unavailable" },
      },
    });
    expect(verifyBearerToken).not.toHaveBeenCalled();
    readiness.stop();
  });

  it("serves MCP requests through a pluggable bearer verifier", async () => {
    const { exchanged, handler } = await createHandler();

    await handler(request(exchanged.accessToken, {
      id: "1",
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    }));
    await handler(request(exchanged.accessToken, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }));

    const response = await handler(request(exchanged.accessToken, {
      id: "2",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    }));
    const payload = await response.json() as { result: { tools: Array<{ name: string }> } };

    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "list_documents",
    ]);
  });

  it("supports direct workspace-token verifier sessions without a saved exchange session", async () => {
    const now = new Date("2026-05-15T12:00:00.000Z");
    const directToken = "radioso_direct";
    const directHandler = createMcpRequestHandler({
      config,
      serverManager: createSessionMcpServerManager({
        config,
      }),
      verifyBearerToken: vi.fn(async (token) => token === directToken
        ? {
            accessTokenHash: hashToken(token),
            approvalRequiredTools: ["create_document"],
            expiresAt: new Date("2999-01-01T00:00:00.000Z"),
            grantedTools: ["describe_capabilities"],
            issuedAt: now,
            sessionId: "merged:workspace-1",
            upstreamApiToken: token,
            workspaceId: "workspace-1",
            workspaceName: "Default",
          }
        : null),
    });

    await directHandler(request(directToken, {
      id: "1",
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    }));

    const response = await directHandler(request(directToken, {
      id: "2",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        tools: [{ name: "describe_capabilities" }],
      },
    });
  });

  it("returns JSON-RPC auth errors when bearer verification fails", async () => {
    const { handler } = await createHandler();

    const response = await handler(request("invalid", {
      id: "1",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32001,
        data: {
          code: "invalid_access_token",
        },
        message: "MCP access token is invalid or expired.",
      },
      id: null,
      jsonrpc: "2.0",
    });
  });
});
