import { describe, expect, it, vi } from "vitest";

import { OperatorMcpCredentialValidationService } from "../../../src/modules/operatorMcpAuthorization/credentialValidationService.js";
import { hashOpaqueCredential } from "../../../src/modules/operatorMcpAuthorization/domain.js";

const id = "00000000-0000-4000-8000-000000000001";
const now = new Date("2026-09-04T00:00:00.000Z");
const current = {
  credential: {
    id,
    grantId: id,
    tokenDigest: hashOpaqueCredential("opaque-access-token"),
    issuedGrantVersion: "2",
    issuedClientVersion: "3",
    issuedClientMetadataSnapshotId: id,
    issuedCredentialEpoch: "4",
    issuedToolScopes: ["operator:read", "operator:probe"] as const,
    issuedOfflineAccess: false,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
    lastUsedAt: null,
  },
  grant: {
    id,
    clientRecordId: id,
    clientId: "https://client.example/cimd",
    clientVersion: "3",
    clientMetadataSnapshotId: id,
    accountId: id,
    workspaceId: id,
    userId: id,
    membershipId: id,
    resource: "https://mcp.example/operator/mcp",
    toolScopes: ["operator:read", "operator:propose"] as const,
    offlineAccess: false,
    status: "active" as const,
    version: "2",
    credentialEpoch: "4",
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
  },
  clientStatus: "active" as const,
  currentClientVersion: "3",
  currentClientMetadataDigest: "metadata-digest",
  grantClientMetadataDigest: "metadata-digest",
  membershipStatus: "active",
  membershipRole: "admin",
  userDisabledAt: null,
};

describe("OperatorMcpCredentialValidationService", () => {
  it("returns only the intersection of issued and current grant scopes", async () => {
    const repository = {
      findCurrentCredential: vi.fn(async () => current),
      findCurrentCredentialById: vi.fn(),
      markCredentialUsed: vi.fn(async () => undefined),
    };
    const service = new OperatorMcpCredentialValidationService(repository, {
      credentialEpoch: "4",
      resource: current.grant.resource,
    });
    await expect(service.validate({ accessToken: "opaque-access-token", resource: current.grant.resource, now })).resolves.toMatchObject({
      credentialId: id,
      currentToolScopes: ["operator:read"],
      grantVersion: "2",
      credentialEpoch: "4",
    });
    expect(repository.findCurrentCredential).toHaveBeenCalledWith({
      now,
      resource: current.grant.resource,
      tokenDigest: hashOpaqueCredential("opaque-access-token"),
    });
  });

  it.each([
    ["disabled user", { userDisabledAt: now }],
    ["ended membership", { membershipStatus: "removed" }],
    ["revoked client", { clientStatus: "revoked" as const }],
    ["current client version changed", { currentClientVersion: "4" }],
    ["current client metadata changed", { currentClientMetadataDigest: "other-digest" }],
    ["grant version changed", { credential: { ...current.credential, issuedGrantVersion: "1" } }],
    ["client version changed", { credential: { ...current.credential, issuedClientVersion: "2" } }],
    ["snapshot changed", { credential: { ...current.credential, issuedClientMetadataSnapshotId: "00000000-0000-4000-8000-000000000002" } }],
    ["credential epoch changed", { credential: { ...current.credential, issuedCredentialEpoch: "3" } }],
  ])("fails closed for %s", async (_label, override) => {
    const record = { ...current, ...override };
    const service = new OperatorMcpCredentialValidationService({
      findCurrentCredential: vi.fn(async () => record),
      findCurrentCredentialById: vi.fn(),
      markCredentialUsed: vi.fn(async () => undefined),
    }, { credentialEpoch: "4", resource: current.grant.resource });
    await expect(service.validate({ accessToken: "opaque-access-token", resource: current.grant.resource, now })).rejects.toMatchObject({ code: "invalid_token" });
  });

  it("rejects wrong audiences and credential classes without a lookup", async () => {
    const repository = { findCurrentCredential: vi.fn(), findCurrentCredentialById: vi.fn(), markCredentialUsed: vi.fn() };
    const service = new OperatorMcpCredentialValidationService(repository, { credentialEpoch: "4", resource: current.grant.resource });
    await expect(service.validate({ accessToken: "radioso_pat_v1_other-class", resource: current.grant.resource, now })).rejects.toMatchObject({ code: "invalid_token" });
    await expect(service.validate({ accessToken: "opaque-access-token", resource: `${current.grant.resource}/`, now })).rejects.toMatchObject({ code: "invalid_target" });
    expect(repository.findCurrentCredential).not.toHaveBeenCalled();
  });
});
