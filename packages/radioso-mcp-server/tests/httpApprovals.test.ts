import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuditLogger } from "../src/audit/auditLogger.js";
import { createAuthService } from "../src/auth/authService.js";
import { createInMemoryApprovalStore } from "../src/auth/approvalStore.js";
import { createInMemorySessionStore } from "../src/auth/sessionStore.js";
import { createHttpServer } from "../src/http/createHttpServer.js";
import { createCapabilityPolicyRegistry } from "../src/policy/capabilityPolicy.js";

const createRuntime = async (options: { now?: () => Date } = {}) => {
  const policy = createCapabilityPolicyRegistry({
    allowedReadTools: ["describe_capabilities"],
    allowedWriteTools: ["create_document"],
    approvalRequiredWriteTools: ["create_document"],
  });
  const authService = createAuthService({
    approvalStore: createInMemoryApprovalStore(),
    auditLogger: createAuditLogger([]),
    now: options.now,
    policy,
    sessionStore: createInMemorySessionStore(),
    signingSecret: "dev-signing-secret",
    validateWorkspaceToken: async () => undefined,
  });
  const server = createHttpServer({
    authService,
    config: {
      accessTokenTtlSeconds: 900,
      allowedReadTools: ["describe_capabilities"],
      allowedWriteTools: ["create_document"],
      approvalRequiredWriteTools: ["create_document"],
      approvalTtlSeconds: 300,
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

describe("remote MCP approvals", () => {
  const runtimes: Array<ReturnType<typeof createRuntime> extends Promise<infer T> ? T : never> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (runtimes.length > 0) {
      await runtimes.pop()!.server.close();
    }
  });

  it("requires approval for governed write tools and accepts a valid approval token", async () => {
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

    const runtime = await createRuntime();
    runtimes.push(runtime);

    const exchangeResponse = await actualFetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        radiosoApiToken: "sk_proj_test",
        requestedTools: ["create_document"],
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

    const deniedResponse = await mcpRequest(runtime.baseUrl, exchange.accessToken, {
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
    const deniedPayload = await deniedResponse.json() as { result: { structuredContent: { code: string } } };

    expect(deniedPayload.result.structuredContent.code).toBe("approval_required");

    const approvalResponse = await actualFetch(`${runtime.baseUrl}/v1/approvals`, {
      body: JSON.stringify({
        reason: "Create remote doc",
        tools: ["create_document"],
      }),
      headers: {
        authorization: `Bearer ${exchange.accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const approval = await approvalResponse.json() as { approvalToken: string };

    const successResponse = await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      id: "3",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          approvalToken: approval.approvalToken,
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
        body: JSON.stringify({
          content: "Created remotely",
          title: "Remote doc",
        }),
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_test",
        }),
        method: "POST",
      }),
    );
  });

  it("rejects an expired approval token for a governed write", async () => {
    let now = new Date("2026-04-21T12:00:00.000Z");
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

    const runtime = await createRuntime({ now: () => now });
    runtimes.push(runtime);

    const exchangeResponse = await actualFetch(`${runtime.baseUrl}/v1/auth/exchange`, {
      body: JSON.stringify({
        radiosoApiToken: "sk_proj_test",
        requestedTools: ["create_document"],
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

    const approvalResponse = await actualFetch(`${runtime.baseUrl}/v1/approvals`, {
      body: JSON.stringify({
        reason: "Create remote doc",
        tools: ["create_document"],
      }),
      headers: {
        authorization: `Bearer ${exchange.accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const approval = await approvalResponse.json() as { approvalToken: string };

    now = new Date("2026-04-21T12:10:00.000Z");

    const expiredResponse = await mcpRequest(runtime.baseUrl, exchange.accessToken, {
      id: "2",
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: {
          approvalToken: approval.approvalToken,
          content: "Created remotely",
          title: "Remote doc",
        },
        name: "create_document",
      },
    });
    const expiredPayload = await expiredResponse.json() as { result: { structuredContent: { code: string } } };

    expect(expiredPayload.result.structuredContent.code).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalledWith(
      "http://radioso.test/api/v1/document",
      expect.anything(),
    );
  });
});
