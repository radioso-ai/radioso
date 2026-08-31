import { describe, expect, it } from "vitest";

import { hashMachineSecret, issueMachineSecret } from "../../../src/modules/machineAccess/credentialSecretCodec.js";
import { PersonalCredentialTenureService } from "../../../src/modules/machineAccess/services/personalCredentialTenureService.js";
import { createAuditService } from "../../support/fakes.js";
import { InMemoryMachineAccessRepository } from "../../support/inMemoryMachineAccess.js";

describe("PersonalCredentialTenureService", () => {
  it("permanently invalidates every credential bound to the ended tenure and records safe evidence", async () => {
    const repository = new InMemoryMachineAccessRepository();
    const audit = createAuditService();
    const secret = issueMachineSecret("personal");
    const now = new Date("2026-08-31T00:00:00.000Z");
    const issued = await repository.createPersonalWithinLimit({
      accountId: "account-1", workspaceId: "workspace-1", ownerUserId: "user-1",
      accessTenureMembershipId: "membership-old", roleCeiling: "member", label: "CLI",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"), createdByUserId: "user-1", now,
      limit: 10, issueSecret: () => secret,
    });
    const service = new PersonalCredentialTenureService({ repository, audit, now: () => now });

    await service.endMembership({ accountId: "account-1", membershipId: "membership-old", actorUserId: "owner-1" });
    // A re-invitation creates a distinct tenure, never a path to revive the old verifier.
    await repository.createPersonalWithinLimit({
      accountId: "account-1", workspaceId: "workspace-1", ownerUserId: "user-1",
      accessTenureMembershipId: "membership-new", roleCeiling: "member", label: "Replacement",
      expiresAt: new Date("2026-10-01T00:00:00.000Z"), createdByUserId: "user-1", now,
      limit: 10, issueSecret: () => issueMachineSecret("personal"),
    });

    expect(issued).not.toBeNull();
    expect(await repository.findCredentialByHash(hashMachineSecret(secret.secret))).toMatchObject({
      revokedAt: now,
      revocationReason: "membership_ended",
    });
    expect(audit.events).toContainEqual(expect.objectContaining({
      eventType: "machine_access.personal_credential.invalidated",
      metadata: expect.objectContaining({ credentialId: issued!.credential.id, reason: "membership_ended", actorUserId: "owner-1" }),
    }));
    expect(JSON.stringify(audit.events)).not.toContain(secret.secret);
    expect(JSON.stringify(audit.events)).not.toContain(secret.tokenHash);
  });

  it("rolls back tenure invalidation when its mandatory audit evidence cannot persist", async () => {
    const repository = new InMemoryMachineAccessRepository();
    const now = new Date("2026-08-31T00:00:00.000Z");
    const issued = await repository.createPersonalWithinLimit({
      accountId: "account-1", workspaceId: "workspace-1", ownerUserId: "user-1", accessTenureMembershipId: "membership-old",
      roleCeiling: "member", label: "CLI", expiresAt: new Date("2026-10-01T00:00:00.000Z"), createdByUserId: "user-1",
      now, limit: 10, issueSecret: () => issueMachineSecret("personal"),
    });
    if (!issued) throw new Error("Expected a credential");
    repository.failAuditPersistence = new Error("audit unavailable");
    const service = new PersonalCredentialTenureService({ repository, audit: createAuditService(), now: () => now });
    await expect(service.endMembership({ accountId: "account-1", membershipId: "membership-old" })).rejects.toThrow("audit unavailable");
    expect(await repository.findCredential(issued.credential.id)).toMatchObject({ revokedAt: null });
  });
});
