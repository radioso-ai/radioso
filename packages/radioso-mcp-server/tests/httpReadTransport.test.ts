import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditLogger } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";

const workspaceValidation = {
  apiVersion: "0.1.0",
  mcpContextVersion: "2026-04-22",
  supportedTools: ["describe_capabilities", "list_documents", "create_document"],
  workspaceHint: "Default",
  workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
  workspaceName: "Default",
};

const createRemoteRuntime = async () => {
  const policy = createCapabilityPolicyRegistry({
    allowedReadTools: ["describe_capabilities", "list_documents"],
    allowedWriteTools: ["create_document"],
    approvalRequiredWriteTools: ["create_document"],
  });
  const authService = createAuthService({
    auditLogger: createAuditLogger([]),
    policy,
    sessionStore: createInMemorySessionStore(),
    signingSecret: "dev-signing-secret",
    validateWorkspaceToken: async () => workspaceValidation,
  });
  const server = createHttpServer({
    authService,
    config: {
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

describe("remote MCP read transport", () => {
  const runtimes: Array<ReturnType<typeof createRemoteRuntime> extends Promise<infer T> ? T : never> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (runtimes.length > 0) {
      await runtimes.pop()!.server.close();
    }
  });

  it("lists only granted tools and uses the exchanged upstream token for reads", async () => {
    const actualFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("http://127.0.0.1")) {
        return actualFetch(input as RequestInfo | URL, init);
      }

      return new Response(JSON.stringify({ documents: [{ id: "doc-1", title: "FAQ" }] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const runtime = await createRemoteRuntime();
    runtimes.push(runtime);

    const exchangeResponse = await actualFetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        radiosoApiToken: "radioso_test",
        requestedTools: ["describe_capabilities", "list_documents"],
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const exchange = await exchangeResponse.json() as { accessToken: string };

    await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      id: "1",
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      },
    });
    await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });

    const toolListResponse = await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      id: "2",
      jsonrpc: "2.0",
      method: "tools/list",
      params: {},
    });
    const toolListPayload = await toolListResponse.json() as { result: { tools: Array<{ name: string }> } };

    expect(toolListPayload.result.tools.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "list_documents",
    ]);

    const listDocumentsResponse = await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      id: "3",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {},
        name: "list_documents",
      },
    });
    const listDocumentsPayload = await listDocumentsResponse.json() as { result: { structuredContent: unknown } };

    expect(listDocumentsPayload.result.structuredContent).toMatchObject({
      documents: [{ id: "doc-1", title: "FAQ" }],
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

  it("returns JSON-RPC auth errors for unauthenticated MCP requests", async () => {
    const runtime = await createRemoteRuntime();
    runtimes.push(runtime);

    const response = await fetch(`${runtime.baseUrl}/mcp`, {
      body: JSON.stringify({
        id: "unauth-1",
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      }),
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      method: "POST",
    });

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
