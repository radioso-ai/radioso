import { describe, expect, it, vi } from "vitest";
import { digestOperatorMcpCall } from "@radioso/operator-mcp-contract";
import { createOperatorMcpRequestHandler, type OperatorMcpRequestHandlerDependencies } from "../src/operator/requestHandler.js";
import { OperatorBackendAdapterError } from "../src/operator/backendAdapter.js";

const proof = {
  version: 1 as const,
  grantId: "00000000-0000-4000-8000-000000000001",
  grantVersion: 1,
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000001",
  clientId: "https://client.example/cimd",
  resource: "https://mcp.example/operator/mcp",
  method: "ping" as const,
  invocationId: "00000000-0000-4000-8000-000000000001",
  bodyDigest: "fG4t0zZQJrS3cT9u1q6Yl8m8fJ5u8w3s9z2x0c1v2b3".slice(0, 43),
  issuedAt: Date.now() - 1000,
  expiresAt: Date.now() + 10_000,
  nonce: "nonce",
  signature: "fG4t0zZQJrS3cT9u1q6Yl8m8fJ5u8w3s9z2x0c1v2b3".slice(0, 43),
};

const dependencies: {
  admit: ReturnType<typeof vi.fn<OperatorMcpRequestHandlerDependencies["admit"]>>;
  call: ReturnType<typeof vi.fn<OperatorMcpRequestHandlerDependencies["call"]>>;
  list: ReturnType<typeof vi.fn<OperatorMcpRequestHandlerDependencies["list"]>>;
} = {
  admit: vi.fn<OperatorMcpRequestHandlerDependencies["admit"]>(async () => ({ proof })),
  call: vi.fn<OperatorMcpRequestHandlerDependencies["call"]>(async () => ({ content: [] })),
  list: vi.fn<OperatorMcpRequestHandlerDependencies["list"]>(async () => ({ tools: [] })),
};

const requestMetadata = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "operator-test", version: "1.0.0" },
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
};

const operatorRequest = (
  body: { id: string | number; method: string; params?: Record<string, unknown>; [key: string]: unknown },
  headerOverrides: Record<string, string> = {},
): Request => {
  const params = { _meta: requestMetadata, ...body.params };
  const name = typeof params.name === "string" ? params.name : undefined;
  return new Request("https://mcp.example/operator/mcp", {
    body: JSON.stringify({ ...body, params }),
    headers: {
      authorization: "Bearer opaque-access-token",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": body.method,
      ...(body.method === "tools/call" && name ? { "mcp-name": name } : {}),
      ...headerOverrides,
    },
    method: "POST",
  });
};

describe("operator MCP stateless request handler", () => {
  it("dispatches a self-describing 2026-07-28 ping without initialization or session state", async () => {
    const handler = createOperatorMcpRequestHandler(dependencies);
    const response = await handler(operatorRequest({ id: "1", jsonrpc: "2.0", method: "ping" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "1",
      jsonrpc: "2.0",
      result: { resultType: "complete" },
    });
    expect(dependencies.admit).toHaveBeenCalledOnce();
  });

  it("dispatches tools/list and tools/call through injected callbacks", async () => {
    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/list" } });
    dependencies.list.mockResolvedValue({ tools: [{ name: "workspace_settings" }] });
    const handler = createOperatorMcpRequestHandler(dependencies);

    const listResponse = await handler(operatorRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      result: {
        cacheScope: "private",
        resultType: "complete",
        tools: [{ name: "workspace_settings" }],
        ttlMs: 0,
      },
    });

    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/call" } });
    dependencies.call.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const operationId = "00000000-0000-4000-8000-000000000099";
    const callResponse = await handler(operatorRequest({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { query: "safe" }, name: "retrieval_probe", operationId },
    }));
    expect(callResponse.status).toBe(200);
    await expect(callResponse.json()).resolves.toMatchObject({ result: { content: [{ text: "ok" }], resultType: "complete" } });
    expect(dependencies.call).toHaveBeenCalledWith(expect.objectContaining({ name: "retrieval_probe", operationId }));
    expect(dependencies.admit).toHaveBeenLastCalledWith(expect.objectContaining({
      invocationId: expect.not.stringMatching(operationId),
      bodyDigest: digestOperatorMcpCall({ name: "retrieval_probe", arguments: { query: "safe" }, operationId }),
    }));
    expect(dependencies.call).toHaveBeenLastCalledWith(expect.objectContaining({
      bodyDigest: digestOperatorMcpCall({ name: "retrieval_probe", arguments: { query: "safe" }, operationId }),
    }));
  });

  it("rejects initialization and older protocol revisions before admission", async () => {
    const handler = createOperatorMcpRequestHandler(dependencies);
    const before = dependencies.admit.mock.calls.length;
    const initialize = await handler(operatorRequest({ id: "initialize", jsonrpc: "2.0", method: "initialize" }));
    expect(initialize.status).toBe(404);
    await expect(initialize.json()).resolves.toMatchObject({ error: { code: -32601 } });

    const oldProtocol = await handler(operatorRequest(
      {
        id: "old-protocol",
        jsonrpc: "2.0",
        method: "tools/list",
        params: {
          _meta: {
            ...requestMetadata,
            "io.modelcontextprotocol/protocolVersion": "2025-11-25",
          },
        },
      },
      { "mcp-protocol-version": "2025-11-25" },
    ));
    expect(oldProtocol.status).toBe(400);
    await expect(oldProtocol.json()).resolves.toMatchObject({
      error: {
        code: -32022,
        data: { requested: "2025-11-25", supported: ["2026-07-28"] },
      },
    });
    expect(dependencies.admit.mock.calls.length).toBe(before);
  });

  it("discovers the standard stateless server profile without durable admission", async () => {
    const handler = createOperatorMcpRequestHandler(dependencies);
    const before = dependencies.admit.mock.calls.length;
    const response = await handler(operatorRequest({ id: "discover", jsonrpc: "2.0", method: "server/discover" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        cacheScope: "public",
        capabilities: { tools: {} },
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
      },
    });
    expect(dependencies.admit.mock.calls.length).toBe(before);
  });

  it("decodes a sentinel-encoded Mcp-Name before comparing it with the body", async () => {
    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/call" } });
    const handler = createOperatorMcpRequestHandler(dependencies);
    const name = "rétrieval_probe";
    const encodedName = `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;
    const response = await handler(operatorRequest(
      { id: "encoded-name", jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name } },
      { "mcp-name": encodedName },
    ));

    expect(response.status).toBe(200);
    expect(dependencies.call).toHaveBeenLastCalledWith(expect.objectContaining({ name }));
  });

  it("rejects missing or mismatched routing headers before admission", async () => {
    const handler = createOperatorMcpRequestHandler(dependencies);
    const before = dependencies.admit.mock.calls.length;
    const cases = [
      new Request("https://mcp.example/operator/mcp", {
        body: "not-json",
        headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
        method: "POST",
      }),
      operatorRequest({ id: "missing-method", jsonrpc: "2.0", method: "tools/list" }, { "mcp-method": "" }),
      operatorRequest({ id: "method-mismatch", jsonrpc: "2.0", method: "tools/list" }, { "mcp-method": "ping" }),
      operatorRequest(
        { id: "name-mismatch", jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "workspace_settings" } },
        { "mcp-name": "retrieval_probe" },
      ),
      operatorRequest(
        {
          id: "version-mismatch",
          jsonrpc: "2.0",
          method: "tools/list",
          params: { _meta: { ...requestMetadata, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } },
        },
      ),
    ];

    for (const request of cases) {
      const response = await handler(request);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32020 } });
    }
    expect(dependencies.admit.mock.calls.length).toBe(before);
  });

  it("rejects malformed call parameters before creating a durable admission", async () => {
    const handler = createOperatorMcpRequestHandler(dependencies);
    const before = dependencies.admit.mock.calls.length;
    for (const params of [
      { name: "retrieval_probe", arguments: "not-an-object" },
      { name: "retrieval_probe", arguments: {}, operationId: "" },
      { name: "x".repeat(129), arguments: {} },
    ]) {
      const response = await handler(operatorRequest({ id: "bad-call", jsonrpc: "2.0", method: "tools/call", params }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32602 } });
    }
    expect(dependencies.admit.mock.calls.length).toBe(before);
  });

  it("fails closed when the admitted workspace is outside the standalone rollout", async () => {
    const list = vi.fn<OperatorMcpRequestHandlerDependencies["list"]>(async () => ({ tools: [] }));
    const handler = createOperatorMcpRequestHandler({
      ...dependencies,
      list,
      rolloutWorkspaceIds: new Set(["00000000-0000-4000-8000-000000000099"]),
    });
    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/list" } });

    const response = await handler(operatorRequest({ id: "rollout", jsonrpc: "2.0", method: "tools/list" }));

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("returns safe 401/403 challenges and rejects oversized calls", async () => {
    const handler = createOperatorMcpRequestHandler({
      ...dependencies,
      admit: vi.fn<OperatorMcpRequestHandlerDependencies["admit"]>(async () => {
        throw new OperatorBackendAdapterError("denied", 403, "insufficient_scope", "operator:probe");
      }),
      resourceMetadataUrl: "https://mcp.example/.well-known/oauth-protected-resource/operator/mcp",
    });
    const response = await handler(operatorRequest({
      id: 4,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "retrieval_probe" },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(response.headers.get("www-authenticate")).toContain("operator:probe");

    const oversized = await createOperatorMcpRequestHandler(dependencies)(operatorRequest({
      id: 5,
      jsonrpc: "2.0",
      method: "tools/list",
      padding: "x".repeat(300_000),
    }));
    expect(oversized.status).toBe(200);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });

  it("returns backend validation errors as invalid params instead of runtime unavailable", async () => {
    const handler = createOperatorMcpRequestHandler({
      ...dependencies,
      call: vi.fn<OperatorMcpRequestHandlerDependencies["call"]>(async () => {
        throw new OperatorBackendAdapterError("Operator request was rejected.", 400, "operation_required");
      }),
    });
    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/call" } });

    const response = await handler(operatorRequest({
      id: "validation",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "workspace_settings" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32602, message: "operation_required" } });
  });

  it("returns backend budget exhaustion as a rate-limit response", async () => {
    const handler = createOperatorMcpRequestHandler({
      ...dependencies,
      call: vi.fn<OperatorMcpRequestHandlerDependencies["call"]>(async () => {
        throw new OperatorBackendAdapterError("Operator request was throttled.", 429, "budget_exhausted");
      }),
    });
    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/call" } });

    const response = await handler(operatorRequest({
      id: "budget",
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "workspace_settings" },
    }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "budget_exhausted" });
  });
});
