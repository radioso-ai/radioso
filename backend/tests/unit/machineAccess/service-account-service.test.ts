import { describe, expect, it } from "vitest";

import { ServiceAccountService } from "../../../src/modules/machineAccess/services/serviceAccountService.js";
import { createAuditService } from "../../support/fakes.js";
import { InMemoryMachineAccessRepository } from "../../support/inMemoryMachineAccess.js";

const now = new Date("2026-08-31T00:00:00.000Z");
const expiresAt = new Date("2027-08-30T00:00:00.000Z");

const createHarness = (actorRole: "member" | "admin" | "owner" = "admin") => {
  const repository = new InMemoryMachineAccessRepository();
  const audit = createAuditService();
  const accountAccess = {
    requirePermission: async () => {
      if (actorRole === "member") {
        const error = Object.assign(new Error("forbidden"), { statusCode: 403 });
        throw error;
      }
    },
    resolveWorkspaceRole: async () => actorRole,
  };
  return {
    audit,
    repository,
    service: new ServiceAccountService({
      repository,
      accountAccess: accountAccess as never,
      audit,
      now: () => now,
    }),
  };
};

const createServiceAccount = (service: ServiceAccountService) => service.createWithCredential({
  accountId: "account-1",
  workspaceId: "workspace-1",
  actorUserId: "admin-1",
  displayName: "Deployment runner",
  role: "admin",
  credentialLabel: "Primary",
  expiresAt,
});

describe("ServiceAccountService", () => {
  it("requires elevated session authority and creates identity plus credential atomically", async () => {
    const member = createHarness("member");
    await expect(createServiceAccount(member.service)).rejects.toMatchObject({ statusCode: 403 });
    expect(member.repository.serviceAccounts).toHaveLength(0);
    expect(member.repository.credentials).toHaveLength(0);

    const admin = createHarness();
    const created = await createServiceAccount(admin.service);
    expect(created.secret).toMatch(/^radioso_svc_v1_/);
    expect(created.account).toMatchObject({ status: "enabled", role: "admin", activeCredentialCount: 1 });
    expect(created.credential.serviceAccountId).toBe(created.account.id);
    expect(admin.repository.credentials.get(created.credential.id)).not.toHaveProperty("secret");
    expect(admin.audit.events).toContainEqual(expect.objectContaining({
      eventType: "machine_access.service_credential.issued",
      metadata: expect.objectContaining({ credentialId: created.credential.id, initialCredential: true }),
    }));
  });

  it("supports overlapping credentials up to the quota without changing the stable principal", async () => {
    const { service } = createHarness();
    const created = await createServiceAccount(service);
    const credentials = [created.credential];
    for (let index = 2; index <= 5; index += 1) {
      const issued = await service.issueCredential({
        accountId: "account-1",
        workspaceId: "workspace-1",
        actorUserId: "admin-1",
        serviceAccountId: created.account.id,
        label: `Credential ${index}`,
        expiresAt,
      });
      credentials.push(issued.credential);
    }
    expect(new Set(credentials.map((credential) => credential.serviceAccountId))).toEqual(new Set([created.account.id]));
    await expect(service.issueCredential({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "admin-1",
      serviceAccountId: created.account.id,
      label: "Over quota",
      expiresAt,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("archives once, invalidates every child, and records the automatic cause", async () => {
    const { audit, repository, service } = createHarness();
    const created = await createServiceAccount(service);
    const second = await service.issueCredential({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "admin-1",
      serviceAccountId: created.account.id,
      label: "Canary",
      expiresAt,
    });

    const archived = await service.update({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "admin-1",
      serviceAccountId: created.account.id,
      revision: 1,
      status: "archived",
    });
    expect(archived).toMatchObject({ status: "archived", activeCredentialCount: 0 });
    expect(repository.credentials.get(created.credential.id)).toMatchObject({ revocationReason: "service_account_archived" });
    expect(repository.credentials.get(second.credential.id)).toMatchObject({ revocationReason: "service_account_archived" });
    expect(audit.events.filter((event) => event.eventType === "machine_access.service_credential.invalidated")).toHaveLength(2);
    await expect(service.update({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "admin-1",
      serviceAccountId: created.account.id,
      revision: archived.revision,
      status: "enabled",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("maps missing or cross-workspace service resources to the 404 boundary", async () => {
    const { service } = createHarness();
    await expect(service.issueCredential({
      accountId: "account-1", workspaceId: "workspace-1", actorUserId: "admin-1",
      serviceAccountId: "missing", label: "Primary", expiresAt,
    })).rejects.toMatchObject({ statusCode: 404 });

    const created = await createServiceAccount(service);
    await expect(service.get({
      accountId: "account-1", workspaceId: "workspace-2", actorUserId: "admin-1", serviceAccountId: created.account.id,
    })).rejects.toMatchObject({ statusCode: 404 });
  });
});
