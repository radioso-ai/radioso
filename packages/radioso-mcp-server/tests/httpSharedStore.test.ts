import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditLogger } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";

const workspaceValidation = {
  apiVersion: "0.1.0",
  mcpContextVersion: "2026-04-22",
  supportedTools: ["describe_capabilities", "create_document"],
  workspaceHint: "Default",
  workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
  workspaceName: "Default",
};

const createRuntime = async (stores: {
  sessionStore: ReturnType<typeof createInMemorySessionStore>;
}) => {
  const policy = createCapabilityPolicyRegistry({
    allowedReadTools: ["describe_capabilities"],
    allowedWriteTools: ["create_document"],
    approvalRequiredWriteTools: ["create_document"],
  });
  const authService = createAuthService({
    auditLogger: createAuditLogger([]),
    policy,
    sessionStore: stores.sessionStore,
    signingSecret: "dev-signing-secret",
    validateWorkspaceToken: async () => workspaceValidation,
  });
  const server = createHttpServer({
    authService,
    config: {
      accessTokenTtlSeconds: 900,
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: ["create_document"],
      approvalRequiredWriteTools: ["create_document"],
      baseUrl: "http://radioso.test",
      bindHost: "127.0.0.1",
      bindPort: 0,
      redisKeyPrefix: "radioso-mcp",
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
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
  };
};

const mcpRequest = async (baseUrl: string, accessToken: string, payload: unknown) =>
  fetch(`${baseUrl}/mcp`, {
    body: JSON.stringify(payload),
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    method: "POST",
  });

describe("remote MCP shared-store flow", () => {
  const runtimes: Array<ReturnType<typeof createRuntime> extends Promise<infer T> ? T : never> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (runtimes.length > 0) {
      await runtimes.pop()!.server.close();
    }
  });

  it("exchanges on one instance and completes a write on another instance", async () => {
    const actualFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://127.0.0.1")) {
        return actualFetch(input as RequestInfo | URL, init);
      }

      return new Response(JSON.stringify({ documentId: "doc-1", status: "queued" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const sharedStores = {
      sessionStore: createInMemorySessionStore(),
    };
    const runtimeA = await createRuntime(sharedStores);
    const runtimeB = await createRuntime(sharedStores);
    runtimes.push(runtimeA, runtimeB);

    const exchangeResponse = await actualFetch(`${runtimeA.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        radiosoApiToken: "radioso_test",
        requestedTools: ["create_document"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const exchange = await exchangeResponse.json() as { accessToken: string };

    await mcpRequest(runtimeB.baseUrl, exchange.accessToken, {
      id: "1",
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    });
    await mcpRequest(runtimeB.baseUrl, exchange.accessToken, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    const successResponse = await mcpRequest(runtimeB.baseUrl, exchange.accessToken, {
      id: "2",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          content: "Created remotely",
          title: "Remote doc",
        },
        name: "create_document",
      },
    });
    const successPayload = await successResponse.json() as { result: { structuredContent: unknown } };

    expect(successPayload.result.structuredContent).toMatchObject({
      documentId: "doc-1",
      status: "queued",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://radioso.test/api/v1/document",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer radioso_test",
        }),
      }),
    );
  });
});
