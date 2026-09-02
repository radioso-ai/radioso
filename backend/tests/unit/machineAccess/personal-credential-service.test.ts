import { describe, expect, it } from "vitest";

import { PersonalCredentialService } from "../../../src/modules/machineAccess/services/personalCredentialService.js";
import { createAuditService } from "../../support/fakes.js";
import { InMemoryMachineAccessRepository } from "../../support/inMemoryMachineAccess.js";

const now = new Date("2026-08-31T00:00:00.000Z");
const expiresAt = new Date("2026-09-30T00:00:00.000Z");

const createHarness = () => {
  const repository = new InMemoryMachineAccessRepository();
  const audit = createAuditService();
  const roles = new Map<string, "member" | "admin" | "owner">([
    ["owner-1", "admin"],
    ["admin-2", "admin"],
    ["member-2", "member"],
  ]);
  const accountAccess = {
    requirePermission: async (input: { userId?: string | null; permission: string }) => {
      const role = input.userId ? roles.get(input.userId) : undefined;
      const allowed = input.permission === "workspace.api_access.personal.manage"
        ? Boolean(role)
        : role === "admin" || role === "owner";
      if (!allowed) {
        throw Object.assign(new Error("forbidden"), { statusCode: 403 });
      }
    },
    requireActiveMembership: async (_accountId: string, userId: string) => ({
      id: `membership-${userId}`,
      accountId: "account-1",
      userId,
      role: roles.get(userId) ?? "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    resolveWorkspaceRole: async (input: { userId?: string | null }) =>
      input.userId ? roles.get(input.userId) ?? null : null,
  };
  return {
    audit,
    repository,
    service: new PersonalCredentialService({
      repository,
      accountAccess: accountAccess as never,
      audit,
      now: () => now,
    }),
  };
};

describe("PersonalCredentialService", () => {
  it("issues one-time, hash-only credentials and enforces the active quota", async () => {
    const { repository, service } = createHarness();
    const issued = await service.issue({
      accountId: "account-1",
      workspaceId: "workspace-1",
      userId: "owner-1",
      label: "  De\u0301ploy  ",
      roleCeiling: "admin",
      expiresAt,
    });

    expect(issued.secret).toMatch(/^radioso_pat_v1_/);
    expect(issued.credential.label).toBe("Déploy");
    expect(issued.credential.tokenHash).not.toContain(issued.secret);
    expect(repository.credentials.get(issued.credential.id)).not.toHaveProperty("secret");

    for (let index = 1; index < 10; index += 1) {
      await service.issue({
        accountId: "account-1",
        workspaceId: "workspace-1",
        userId: "owner-1",
        label: `Token ${index}`,
        roleCeiling: "member",
        expiresAt,
      });
    }
    await expect(service.issue({
      accountId: "account-1",
      workspaceId: "workspace-1",
      userId: "owner-1",
      label: "Over quota",
      roleCeiling: "member",
      expiresAt,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("keeps mutation owner-only while allowing an administrator to revoke safely", async () => {
    const { audit, service } = createHarness();
    const issued = await service.issue({
      accountId: "account-1",
      workspaceId: "workspace-1",
      userId: "owner-1",
      label: "Deploy",
      roleCeiling: "member",
      expiresAt,
    });

    await expect(service.relabel({
      accountId: "account-1",
      workspaceId: "workspace-1",
      userId: "member-2",
      credentialId: issued.credential.id,
      label: "Not mine",
    })).rejects.toMatchObject({ statusCode: 403 });

    const revoked = await service.revoke({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "admin-2",
      credentialId: issued.credential.id,
    });
    expect(revoked).toMatchObject({
      ownerUserId: "owner-1",
      revokedAt: now,
      revokedByUserId: "admin-2",
      revocationReason: "explicit",
    });
    expect(audit.events).toContainEqual(expect.objectContaining({
      eventType: "machine_access.personal_credential.revoked",
      metadata: expect.objectContaining({
        actorUserId: "admin-2",
        principalId: "owner-1",
        credentialId: issued.credential.id,
      }),
    }));
  });

  it("rejects personal credentials when expiry is omitted", async () => {
    const { service } = createHarness();

    await expect(service.issue({
      accountId: "account-1",
      workspaceId: "workspace-1",
      userId: "owner-1",
      label: "Forever",
      roleCeiling: "member",
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects personal credentials beyond the 90-day lifetime", async () => {
    const { service } = createHarness();

    await expect(service.issue({
      accountId: "account-1",
      workspaceId: "workspace-1",
      userId: "owner-1",
      label: "Too long",
      roleCeiling: "member",
      expiresAt: new Date("2026-11-30T00:00:00.001Z"),
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rolls back issue, relabel, and revoke when their required audit write fails", async () => {
    const { repository, service } = createHarness();
    repository.failAuditPersistence = new Error("audit unavailable");
    await expect(service.issue({
      accountId: "account-1", workspaceId: "workspace-1", userId: "owner-1", label: "Deploy", roleCeiling: "member", expiresAt,
    })).rejects.toThrow("audit unavailable");
    expect(repository.credentials).toHaveLength(0);

    repository.failAuditPersistence = null;
    const issued = await service.issue({
      accountId: "account-1", workspaceId: "workspace-1", userId: "owner-1", label: "Deploy", roleCeiling: "member", expiresAt,
    });
    repository.failAuditPersistence = new Error("audit unavailable");
    await expect(service.relabel({
      accountId: "account-1", workspaceId: "workspace-1", userId: "owner-1", credentialId: issued.credential.id, label: "Renamed",
    })).rejects.toThrow("audit unavailable");
    expect(repository.credentials.get(issued.credential.id)).toMatchObject({ label: "Deploy", revokedAt: null });
    await expect(service.revoke({
      accountId: "account-1", workspaceId: "workspace-1", actorUserId: "owner-1", credentialId: issued.credential.id,
    })).rejects.toThrow("audit unavailable");
    expect(repository.credentials.get(issued.credential.id)).toMatchObject({ revokedAt: null });
  });
});
