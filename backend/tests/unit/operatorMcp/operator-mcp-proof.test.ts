import { describe, expect, it } from "vitest";

import { createOperatorProof, verifyOperatorProof, type OperatorProofClaims } from "../../../src/modules/operatorMcpAuthorization/proof.js";

const id = "00000000-0000-4000-8000-000000000001";
const input: OperatorProofClaims = {
  accountId: id,
  bodyDigest: "A".repeat(43),
  clientId: "https://client.example/cimd",
  clientMetadataSnapshotId: id,
  clientVersion: "2",
  credentialEpoch: "3",
  credentialId: id,
  expiresAt: 20_000,
  grantId: id,
  grantVersion: "4",
  invocationId: id,
  issuedAt: 1_000,
  issuedOfflineAccess: false,
  issuedToolScopes: ["operator:read"],
  method: "tools/list" as const,
  nonce: "one-time-nonce",
  resource: "https://mcp.example/operator/mcp",
  userId: id,
  version: 1 as const,
  workspaceId: id,
};

describe("operator MCP proof adapter", () => {
  it("signs the complete credential ceiling and rejects mutations", () => {
    const proof = createOperatorProof(input, "a-secure-shared-service-secret");
    expect(verifyOperatorProof(proof, "a-secure-shared-service-secret", 10_000)).toBe(true);
    expect(verifyOperatorProof({ ...proof, credentialEpoch: "5" }, "a-secure-shared-service-secret", 10_000)).toBe(false);
    expect(verifyOperatorProof({ ...proof, issuedToolScopes: ["operator:probe"] }, "a-secure-shared-service-secret", 10_000)).toBe(false);
    expect(verifyOperatorProof(proof, "a-different-shared-service-secret", 10_000)).toBe(false);
  });

  it("rejects expired and overlong proof lifetimes", () => {
    const proof = createOperatorProof(input, "a-secure-shared-service-secret");
    expect(verifyOperatorProof(proof, "a-secure-shared-service-secret", 100_000)).toBe(false);
    const overlong = createOperatorProof({ ...input, expiresAt: 31_001 }, "a-secure-shared-service-secret");
    expect(verifyOperatorProof(overlong, "a-secure-shared-service-secret", 10_000)).toBe(false);
  });
});
