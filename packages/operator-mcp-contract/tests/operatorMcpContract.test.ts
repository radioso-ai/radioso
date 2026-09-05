import { describe, expect, it } from "vitest";
import {
  OperatorAdmissionRequestSchema,
  OperatorAdmissionResponseSchema,
  OperatorCatalogResponseSchema,
  OperatorInvocationRequestSchema,
  OPERATOR_MCP_EXECUTION_TIMEOUT_MS,
  OPERATOR_MCP_PROTOCOL_VERSION,
  createOperatorMcpProof,
  canonicalizeOperatorResource,
  digestOperatorMcpCall,
  verifyOperatorMcpProof,
  sha256Digest,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const base = {
  credentialId: id,
  credentialEpoch: "1",
  version: 1 as const,
  grantId: id,
  grantVersion: "1",
  accountId: id,
  workspaceId: id,
  userId: id,
  clientId: "https://client.example/cimd",
  clientVersion: "1",
  clientMetadataSnapshotId: id,
  resource: "https://mcp.example/operator/mcp",
  method: "tools/list" as const,
  invocationId: id,
  bodyDigest: sha256Digest("{}"),
  issuedToolScopes: ["operator:read" as const],
  issuedOfflineAccess: false,
  issuedAt: 1_000,
  expiresAt: 20_000,
  nonce: "nonce",
};

describe("operator MCP contract", () => {
  it("pins the protocol revision and validates admission DTOs", () => {
    expect(OPERATOR_MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(OPERATOR_MCP_EXECUTION_TIMEOUT_MS).toBe(60_000);
    expect(() => OperatorAdmissionRequestSchema.parse({
      accessToken: "opaque",
      invocationId: id,
      method: "tools/list",
      resource: base.resource,
      timestamp: "1000",
      nonce: "n",
      bodyDigest: base.bodyDigest,
    })).not.toThrow();
  });

  it("requires the complete credential and grant binding in every proof", () => {
    const proof = createOperatorMcpProof({
      ...base,
      clientMetadataSnapshotId: id,
      clientVersion: "3",
      credentialEpoch: "7",
      credentialId: id,
      issuedOfflineAccess: true,
      issuedToolScopes: ["operator:read"],
      secret: "a-secure-test-key",
    });
    expect(proof.credentialId).toBe(id);
    expect(proof.grantVersion).toBe("1");
    expect(proof.clientVersion).toBe("3");
    expect(proof.credentialEpoch).toBe("7");
    expect(() => createOperatorMcpProof({
      ...base,
      clientMetadataSnapshotId: id,
      clientVersion: "03",
      credentialEpoch: "7",
      credentialId: id,
      issuedOfflineAccess: false,
      issuedToolScopes: ["operator:read", "operator:read"],
      secret: "a-secure-test-key",
    })).toThrow();
    for (const invalid of ["01", "1x", "-1", "1.0", "9007199254740993n"]) {
      expect(() => createOperatorMcpProof({ ...base, grantVersion: invalid, secret: "a-secure-test-key" })).toThrow();
    }
    expect(() => createOperatorMcpProof({ ...base, clientMetadataSnapshotId: "not-a-uuid", secret: "a-secure-test-key" })).toThrow();
  });

  it("authenticates every credential, scope, client, and epoch claim", () => {
    const proof = createOperatorMcpProof({ ...base, secret: "a-secure-test-key" });
    for (const field of ["credentialId", "credentialEpoch", "grantVersion", "clientVersion", "clientMetadataSnapshotId", "issuedToolScopes", "issuedOfflineAccess"] as const) {
      const mutated = { ...proof, [field]: field === "issuedToolScopes" ? ["operator:probe"] : field === "issuedOfflineAccess" ? true : "mutated" };
      expect(verifyOperatorMcpProof({ proof: mutated, secret: "a-secure-test-key", now: 10_000 })).toBe(false);
    }
  });

  it("signs proofs, rejects mutation and wrong keys, and permits one replay only at the persistence boundary", () => {
    const proof = createOperatorMcpProof({ ...base, secret: "a-secure-test-key" });
    expect(verifyOperatorMcpProof({ proof, secret: "a-secure-test-key", now: 10_000 })).toBe(true);
    expect(verifyOperatorMcpProof({ proof: { ...proof, method: "tools/call" }, secret: "a-secure-test-key", now: 10_000 })).toBe(false);
    expect(verifyOperatorMcpProof({ proof, secret: "another-key", now: 10_000 })).toBe(false);
    // The codec authenticates the envelope. Replay consumption is deliberately
    // owned by the backend repository, so a valid proof remains immutable.
    expect(verifyOperatorMcpProof({ proof, secret: "a-secure-test-key", now: 10_000 })).toBe(true);
  });

  it("keeps admission and catalog responses uncached", () => {
    const proof = createOperatorMcpProof({ ...base, secret: "a-secure-test-key" });
    expect(OperatorAdmissionResponseSchema.parse({ proof })).toEqual({ proof });
    expect(OperatorCatalogResponseSchema.parse({ tools: [] })).toEqual({ tools: [] });
    expect(() => OperatorAdmissionResponseSchema.parse({ proof, cacheKey: "grant-private" })).toThrow();
    expect(() => OperatorCatalogResponseSchema.parse({ tools: [], cacheKey: "grant-private" })).toThrow();
  });

  it("requires an exact canonical audience and rejects a trailing slash", () => {
    expect(canonicalizeOperatorResource("https://mcp.example/operator/mcp")).toBe("https://mcp.example/operator/mcp");
    expect(canonicalizeOperatorResource("https://mcp.example/operator/mcp/")).toBeNull();
  });

  it("canonically binds call name, arguments, and operation identity", () => {
    const bodyDigest = digestOperatorMcpCall({
      arguments: { query: "safe", filters: { b: 2, a: 1 } },
      name: "retrieval_probe",
      operationId: "operation-1",
    });
    expect(bodyDigest).toBe(digestOperatorMcpCall({
      arguments: { filters: { a: 1, b: 2 }, query: "safe" },
      name: "retrieval_probe",
      operationId: "operation-1",
    }));
    expect(bodyDigest).not.toBe(digestOperatorMcpCall({
      arguments: { query: "tampered" },
      name: "retrieval_probe",
      operationId: "operation-1",
    }));
    expect(() => OperatorInvocationRequestSchema.parse({
      proof: createOperatorMcpProof({ ...base, method: "tools/call", descriptorName: "retrieval_probe", bodyDigest, secret: "a-secure-test-key" }),
      name: "retrieval_probe",
      arguments: { query: "safe" },
    })).toThrow();
  });
});
