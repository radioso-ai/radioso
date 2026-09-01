import { describe, expect, it, vi } from "vitest";

import type { ApiCredentialRecord, ServiceAccountRecord } from "../../../src/modules/machineAccess/ports.js";
import { ApiPrincipalAuthenticator } from "../../../src/modules/machineAccess/services/apiPrincipalAuthenticator.js";
import { issueMachineSecret } from "../../../src/modules/machineAccess/credentialSecretCodec.js";

const now = new Date("2026-08-31T00:00:00.000Z");

const personalRecord = (tokenHash: string): ApiCredentialRecord => ({
  id: "credential-1",
  accountId: "account-1",
  workspaceId: "workspace-1",
  kind: "personal",
  label: "personal",
  tokenPrefix: "radioso_pat_v1_test",
  tokenHash,
  roleCeiling: "admin",
  ownerUserId: "user-1",
  accessTenureMembershipId: "membership-1",
  serviceAccountId: null,
  createdByUserId: "user-1",
  createdAt: now,
  updatedAt: now,
  expiresAt: new Date("2026-09-01T00:00:00.000Z"),
  lastUsedAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null,
  rotatedFromCredentialId: null,
  revision: 1,
});

const serviceAccount: ServiceAccountRecord = {
  id: "service-1",
  accountId: "account-1",
  workspaceId: "workspace-1",
  displayName: "service",
  role: "member",
  status: "enabled",
  createdByUserId: "user-1",
  createdAt: now,
  updatedAt: now,
  disabledAt: null,
  archivedAt: null,
  lastUsedAt: null,
  revision: 1,
};

const createHarness = (credential: ApiCredentialRecord) => {
  const repository = {
    findCredentialByHash: vi.fn().mockResolvedValue(credential),
    findServiceAccount: vi.fn().mockResolvedValue(serviceAccount),
    touchCredentialUse: vi.fn().mockResolvedValue(undefined),
  };
  const accountAccess = {
    findActiveMembershipById: vi.fn().mockResolvedValue({
      id: "membership-1",
      accountId: "account-1",
      userId: "user-1",
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    resolveWorkspaceRole: vi.fn().mockResolvedValue("member"),
  };
  const authenticationObserver = { recordAuthentication: vi.fn(), recordLastUsePersistenceFailure: vi.fn() };
  const authenticator = new ApiPrincipalAuthenticator({
    repository,
    accountAccess: accountAccess as never,
    authenticationObserver,
    now: () => now,
  });
  return { accountAccess, authenticationObserver, authenticator, repository };
};

describe("ApiPrincipalAuthenticator", () => {
  it("caps a personal credential by the current live role", async () => {
    const issued = issueMachineSecret("personal");
    const { authenticationObserver, authenticator, repository } = createHarness(personalRecord(issued.tokenHash));

    await expect(authenticator.authenticate(issued.secret)).resolves.toEqual({
      accountId: "account-1",
      workspaceId: "workspace-1",
      principal: {
        type: "personal_api_credential",
        userId: "user-1",
        credentialId: "credential-1",
        role: "member",
        workspaceId: "workspace-1",
      },
    });
    expect(repository.touchCredentialUse).toHaveBeenCalledWith({ credentialId: "credential-1", at: now });
    expect(authenticationObserver.recordAuthentication).toHaveBeenCalledWith({
      outcome: "success",
      principalKind: "personal",
      reason: "authenticated",
    });
  });

  it("invalidates a personal credential when its exact membership tenure ends or changes account", async () => {
    const issued = issueMachineSecret("personal");
    const first = createHarness(personalRecord(issued.tokenHash));
    first.accountAccess.findActiveMembershipById.mockResolvedValueOnce(null);
    await expect(first.authenticator.authenticate(issued.secret)).rejects.toMatchObject({ statusCode: 401 });

    const second = createHarness(personalRecord(issued.tokenHash));
    second.accountAccess.findActiveMembershipById.mockResolvedValueOnce({
      id: "membership-1",
      accountId: "different-account",
      userId: "user-1",
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await expect(second.authenticator.authenticate(issued.secret)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("uses live service-account state and does not deny access when last-use persistence fails", async () => {
    const issued = issueMachineSecret("service");
    const credential: ApiCredentialRecord = {
      ...personalRecord(issued.tokenHash),
      kind: "service",
      roleCeiling: null,
      ownerUserId: null,
      accessTenureMembershipId: null,
      serviceAccountId: "service-1",
    };
    const { authenticationObserver, authenticator, repository } = createHarness(credential);
    repository.touchCredentialUse.mockRejectedValueOnce(new Error("metadata unavailable"));

    await expect(authenticator.authenticate(issued.secret)).resolves.toMatchObject({
      principal: { type: "service_account_credential", serviceAccountId: "service-1", role: "member" },
    });
    await Promise.resolve();
    expect(authenticationObserver.recordLastUsePersistenceFailure).toHaveBeenCalledOnce();

    repository.findServiceAccount.mockResolvedValueOnce({ ...serviceAccount, status: "disabled" });
    await expect(authenticator.authenticate(issued.secret)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("authenticates credentials with no expiry", async () => {
    const personal = issueMachineSecret("personal");
    const personalHarness = createHarness({ ...personalRecord(personal.tokenHash), expiresAt: null });
    await expect(personalHarness.authenticator.authenticate(personal.secret)).resolves.toMatchObject({
      principal: { type: "personal_api_credential", credentialId: "credential-1" },
    });

    const service = issueMachineSecret("service");
    const serviceHarness = createHarness({
      ...personalRecord(service.tokenHash),
      kind: "service",
      roleCeiling: null,
      ownerUserId: null,
      accessTenureMembershipId: null,
      serviceAccountId: "service-1",
      expiresAt: null,
    });
    await expect(serviceHarness.authenticator.authenticate(service.secret)).resolves.toMatchObject({
      principal: { type: "service_account_credential", serviceAccountId: "service-1" },
    });
  });

  it("returns the same unauthorized boundary for malformed, expired, and revoked credentials", async () => {
    const issued = issueMachineSecret("personal");
    const malformed = createHarness(personalRecord(issued.tokenHash));
    await expect(malformed.authenticator.authenticate("not-a-token")).rejects.toMatchObject({ statusCode: 401 });
    expect(malformed.authenticationObserver.recordAuthentication).toHaveBeenCalledWith({
      outcome: "denied",
      principalKind: "unknown",
      reason: "malformed",
    });

    for (const [state, reason] of [
      [{ expiresAt: now }, "expired"],
      [{ revokedAt: new Date("2026-08-30T00:00:00.000Z") }, "revoked"],
    ] as const) {
      const credential = { ...personalRecord(issued.tokenHash), ...state };
      const { authenticationObserver, authenticator } = createHarness(credential);
      await expect(authenticator.authenticate(issued.secret)).rejects.toMatchObject({ statusCode: 401 });
      expect(authenticationObserver.recordAuthentication).toHaveBeenCalledWith({
        outcome: "denied",
        principalKind: "personal",
        reason,
      });
    }
  });
});
