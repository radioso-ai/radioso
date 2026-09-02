import { describe, expect, it } from "vitest";

import { presentApiCredential } from "../../../src/app/http/presenters/apiAccessPresenter.js";
import { deriveCredentialStatus } from "../../../src/modules/machineAccess/domain.js";
import type { ApiCredentialRecord } from "../../../src/modules/machineAccess/ports.js";

const now = new Date("2026-08-31T00:00:00.000Z");
const credential: ApiCredentialRecord = {
  id: "credential-1", accountId: "account-1", workspaceId: "workspace-1", kind: "service", label: "Deploy",
  tokenPrefix: "radioso_svc_v1_test", tokenHash: "hash", roleCeiling: null, ownerUserId: null,
  accessTenureMembershipId: null, serviceAccountId: "service-1", createdByUserId: "user-1",
  createdAt: now, updatedAt: now, expiresAt: new Date("2026-08-30T00:00:00.000Z"), lastUsedAt: null,
  revokedAt: null, revokedByUserId: null, revocationReason: null, rotatedFromCredentialId: null, revision: 1,
};

describe("API access credential presentation", () => {
  it("does not advertise a warning after expiry", () => {
    expect(presentApiCredential(credential)).toMatchObject({ status: "expired", expiryWarningDays: null });
  });

  it("distinguishes disabled, archived, and missing service-account bindings", () => {
    const active = { ...credential, expiresAt: new Date("2026-09-02T00:00:00.000Z") };
    expect(deriveCredentialStatus({ ...active, serviceAccountStatus: "disabled", now })).toBe("suspended");
    expect(deriveCredentialStatus({ ...active, serviceAccountStatus: "archived", now })).toBe("invalid");
    expect(deriveCredentialStatus({ ...active, serviceAccountStatus: null, now })).toBe("invalid");
  });

  it("presents the required expiry and its warning window", () => {
    const expiring = { ...credential, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) };

    expect(presentApiCredential(expiring)).toMatchObject({
      expiresAt: expiring.expiresAt.toISOString(),
      status: "active",
      expiryWarningDays: 1,
    });
  });
});
