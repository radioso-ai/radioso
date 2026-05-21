import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditLogger } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { DEFAULT_MAX_REQUEST_BODY_BYTES } from "../src/http/nodeHttp.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";

const createTestServer = async () => {
  const policy = createCapabilityPolicyRegistry({
    allowedReadTools: ["describe_capabilities", "list_documents", "search_documents"],
    allowedWriteTools: ["create_document"],
    approvalRequiredWriteTools: ["create_document"],
  });
  const authService = createAuthService({
    auditLogger: createAuditLogger([]),
    policy,
    sessionStore: createInMemorySessionStore(),
    signingSecret: "dev-signing-secret",
    validateWorkspaceToken: vi.fn().mockResolvedValue({ workspaceHint: "workspace-123" }),
  });
  const server = createHttpServer({
    authService,
    config: {
      accessTokenTtlSeconds: 900,
      allowedReadTools: policy.listCapabilities().filter((tool) => tool.accessMode === "read").map((tool) => tool.name),
      allowedWriteTools: policy.listCapabilities().filter((tool) => tool.accessMode === "write").map((tool) => tool.name),
      approvalRequiredWriteTools: ["create_document"],
      baseUrl: "http://radioso.test",
      bindHost: "127.0.0.1",
      bindPort: 0,
      requestTimeoutMs: 30_000,
      serverName: "radioso-test",
      signingSecret: "dev-signing-secret",
    },
  });

  await server.listen();

  const address = server.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address.");
  }

  return {
    authService,
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
};

describe("remote auth exchange", () => {
  const servers: Array<ReturnType<typeof createTestServer> extends Promise<infer T> ? T : never> = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.server.close();
    }
  });

  it("exchanges a workspace token for an MCP access token", async () => {
    const runtime = await createTestServer();
    servers.push(runtime);

    const response = await fetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        clientName: "remote-test",
        radiosoApiToken: "radioso_test",
        requestedTools: ["describe_capabilities", "list_documents"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      approvalRequiredTools: [],
      grantedTools: ["describe_capabilities", "list_documents"],
      tokenType: "Bearer",
      workspaceHint: "workspace-123",
    });
  });

  it("rejects oversized auth exchange bodies before validation", async () => {
    const runtime = await createTestServer();
    servers.push(runtime);

    const response = await fetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: "x".repeat(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "payload_too_large",
        details: {
          maxBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
        },
      },
    });
  });
});
