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

describe("operator MCP stateless request handler", () => {
  it("dispatches a self-describing 2026-07-28 ping without initialization or session state", async () => {
    const handler = createOperatorMcpRequestHandler(dependencies);
    const response = await handler(new Request("https://mcp.example/operator/mcp", {
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "ping", params: {}, protocolVersion: "2026-07-28" }),
      headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
      method: "POST",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "1", jsonrpc: "2.0", result: {} });
    expect(dependencies.admit).toHaveBeenCalledOnce();
  });

  it("dispatches tools/list and tools/call through injected callbacks", async () => {
    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/list" } });
    dependencies.list.mockResolvedValue({ tools: [{ name: "workspace_settings" }] });
    const handler = createOperatorMcpRequestHandler(dependencies);

    const listResponse = await handler(new Request("https://mcp.example/operator/mcp", {
      body: JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list", protocolVersion: "2026-07-28" }),
      headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
      method: "POST",
    }));
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({ result: { tools: [{ name: "workspace_settings" }] } });

    dependencies.admit.mockResolvedValue({ proof: { ...proof, method: "tools/call" } });
    dependencies.call.mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const operationId = "00000000-0000-4000-8000-000000000099";
    const callResponse = await handler(new Request("https://mcp.example/operator/mcp", {
      body: JSON.stringify({
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { query: "safe" }, name: "retrieval_probe", operationId },
        protocolVersion: "2026-07-28",
      }),
      headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
      method: "POST",
    }));
    expect(callResponse.status).toBe(200);
    await expect(callResponse.json()).resolves.toMatchObject({ result: { content: [{ text: "ok" }] } });
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
    for (const method of ["initialize", "tools/list"] as const) {
      const response = await handler(new Request("https://mcp.example/operator/mcp", {
        body: JSON.stringify({ id: "bad", jsonrpc: "2.0", method, protocolVersion: method === "initialize" ? "2026-07-28" : "2025-11-25" }),
        headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
        method: "POST",
      }));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ error: { code: -32600 } });
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
      const response = await handler(new Request("https://mcp.example/operator/mcp", {
        body: JSON.stringify({ id: "bad-call", jsonrpc: "2.0", method: "tools/call", params, protocolVersion: "2026-07-28" }),
        headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
        method: "POST",
      }));
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

    const response = await handler(new Request("https://mcp.example/operator/mcp", {
      body: JSON.stringify({ id: "rollout", jsonrpc: "2.0", method: "tools/list", protocolVersion: "2026-07-28" }),
      headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" },
      method: "POST",
    }));

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
    const response = await handler(new Request("https://mcp.example/operator/mcp", {
      body: JSON.stringify({ id: 4, jsonrpc: "2.0", method: "tools/call", protocolVersion: "2026-07-28", params: { name: "retrieval_probe" } }),
      headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" }, method: "POST",
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
    expect(response.headers.get("www-authenticate")).toContain("operator:probe");

    const oversized = await createOperatorMcpRequestHandler(dependencies)(new Request("https://mcp.example/operator/mcp", {
      body: JSON.stringify({ id: 5, jsonrpc: "2.0", method: "tools/list", protocolVersion: "2026-07-28", padding: "x".repeat(300_000) }),
      headers: { authorization: "Bearer opaque-access-token", "content-type": "application/json" }, method: "POST",
    }));
    expect(oversized.status).toBe(200);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: -32600 } });
  });
});
