import { describe, expect, it, vi } from "vitest";
import { createOperatorBackendAdapter, operatorBackendRequestTimeoutMs } from "../src/operator/backendAdapter.js";
import { createOperatorMcpProof, digestOperatorMcpCall, OPERATOR_MCP_EXECUTION_TIMEOUT_MS, sha256Digest } from "@radioso/operator-mcp-contract";

const id = "00000000-0000-4000-8000-000000000001";
const proof = createOperatorMcpProof({
  accountId: id, bodyDigest: sha256Digest("{}"), clientId: "https://client.example/cimd",
  clientMetadataSnapshotId: id, clientVersion: "1", credentialEpoch: "1", credentialId: id,
  expiresAt: Date.now() + 10_000, grantId: id, grantVersion: "1", invocationId: id,
  issuedOfflineAccess: false, issuedToolScopes: ["operator:read"], issuedAt: Date.now(), method: "tools/list",
  nonce: "nonce", resource: "https://mcp.example/operator/mcp", secret: "adapter-secret-key-12345678901234567890", version: 1,
  userId: id, workspaceId: id,
});

describe("operator backend adapter", () => {
  it("keeps the edge deadline beyond the backend execution ceiling", () => {
    expect(operatorBackendRequestTimeoutMs(30_000)).toBeGreaterThan(OPERATOR_MCP_EXECUTION_TIMEOUT_MS);
    expect(operatorBackendRequestTimeoutMs(90_000)).toBe(90_000);
  });

  it("signs internal calls with body binding and never leaks raw credential/error bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ proof }), { status: 200 }));
    const adapter = createOperatorBackendAdapter({ baseUrl: "https://app.example/", fetchImpl, internalSecret: "adapter-secret-key-12345678901234567890", requestTimeoutMs: 1000 });
    await adapter.admit({ accessToken: "raw-access-token", bodyDigest: sha256Digest("{}"), invocationId: id, method: "tools/list", nonce: "n", resource: "https://mcp.example/operator/mcp", timestamp: "1" });
    expect(fetchImpl).toHaveBeenCalledWith("https://app.example/api/v1/internal/operator-copilot/mcp/admissions", expect.objectContaining({ method: "POST" }));
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect((init.body as string)).toContain("raw-access-token");
    expect((init.headers as Record<string, string>)["x-radioso-operator-signature"]).toEqual(expect.any(String));
    const failing = vi.fn<typeof fetch>().mockResolvedValue(new Response("customer secret raw-access-token", { status: 502 }));
    await expect(createOperatorBackendAdapter({ baseUrl: "https://app.example", fetchImpl: failing, internalSecret: "adapter-secret-key-12345678901234567890", requestTimeoutMs: 1000 }).admit({ accessToken: "raw-access-token", bodyDigest: sha256Digest("{}"), invocationId: id, method: "tools/list", nonce: "n", resource: "https://mcp.example/operator/mcp", timestamp: "1" })).rejects.not.toThrow(/raw-access-token|customer secret/);
  });

  it("maps an upstream timeout to a safe unavailable error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    }));
    await expect(createOperatorBackendAdapter({ baseUrl: "https://app.example", fetchImpl, internalSecret: "adapter-secret-key-12345678901234567890", requestTimeoutMs: 1 }).admit({ accessToken: "opaque", bodyDigest: sha256Digest("{}"), invocationId: id, method: "tools/list", nonce: "n", resource: "https://mcp.example/operator/mcp", timestamp: "1" })).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("preserves safe backend application errors without leaking response bodies", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "operation_required", message: "contains customer data" }), { status: 400 }));

    await expect(createOperatorBackendAdapter({
      baseUrl: "https://app.example",
      fetchImpl,
      internalSecret: "adapter-secret-key-12345678901234567890",
      requestTimeoutMs: 1_000,
    }).invoke({
      proof,
      name: "workspace_settings",
      arguments: {},
      bodyDigest: sha256Digest("{}"),
    })).rejects.toMatchObject({ code: "operation_required", status: 400 });
  });

  it("preserves an unknown tool as a safe client error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      code: "unknown_tool",
      message: "unknown_tool",
    }), { status: 400 }));

    await expect(createOperatorBackendAdapter({
      baseUrl: "https://app.example",
      fetchImpl,
      internalSecret: "adapter-secret-key-12345678901234567890",
      requestTimeoutMs: 1_000,
    }).invoke({
      proof,
      name: "removed_tool",
      arguments: {},
      bodyDigest: sha256Digest("{}"),
    })).rejects.toMatchObject({ code: "unknown_tool", status: 400 });
  });

  it("maps backend budget exhaustion to a throttling error", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: "budget_exhausted", message: "limit" }), { status: 429 }));

    await expect(createOperatorBackendAdapter({
      baseUrl: "https://app.example",
      fetchImpl,
      internalSecret: "adapter-secret-key-12345678901234567890",
      requestTimeoutMs: 1_000,
    }).invoke({
      proof,
      name: "workspace_settings",
      arguments: {},
      bodyDigest: sha256Digest("{}"),
    })).rejects.toMatchObject({ code: "budget_exhausted", status: 429 });
  });

  it("carries the canonical call digest through the signed invocation request", async () => {
    const call = { name: "workspace_settings", arguments: { section: "retrieval" } };
    const bodyDigest = digestOperatorMcpCall(call);
    const { signature: _signature, ...proofClaims } = proof;
    const callProof = createOperatorMcpProof({
      ...proofClaims,
      method: "tools/call",
      descriptorName: call.name,
      bodyDigest,
      secret: "adapter-secret-key-12345678901234567890",
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ content: [], safeOutcomeCode: "completed" }), { status: 200 }));
    const adapter = createOperatorBackendAdapter({
      baseUrl: "https://app.example",
      fetchImpl,
      internalSecret: "adapter-secret-key-12345678901234567890",
      requestTimeoutMs: 1_000,
    });

    await adapter.invoke({ proof: callProof, ...call, bodyDigest });

    const payload = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(payload.bodyDigest).toBe(bodyDigest);
  });
});
