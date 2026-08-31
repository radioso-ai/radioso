import { describe, expect, it, vi } from "vitest";

import { ServiceAccountService } from "../../../src/modules/machineAccess/services/serviceAccountService.js";
import { createAuditService } from "../../support/fakes.js";
import { InMemoryMachineAccessRepository } from "../../support/inMemoryMachineAccess.js";

const now = new Date("2026-08-31T00:00:00.000Z");
const expiresAt = new Date("2027-08-30T00:00:00.000Z");

const createHarness = () => {
  const repository = new InMemoryMachineAccessRepository();
  const audit = createAuditService();
  const roles = new Map<string, "member" | "admin" | "owner">([
    ["creator-1", "admin"],
    ["operator-2", "admin"],
  ]);
  const accountAccess = {
    requirePermission: vi.fn().mockResolvedValue(undefined),
    resolveWorkspaceRole: vi.fn(async ({ userId }: { userId: string }) => roles.get(userId) ?? "member"),
  };
  const service = new ServiceAccountService({
    repository,
    accountAccess: accountAccess as never,
    audit,
    now: () => now,
  });
  return { accountAccess, audit, repository, roles, service };
};

const createServiceAccount = (service: ServiceAccountService) => service.createWithCredential({
  accountId: "account-1",
  workspaceId: "workspace-1",
  actorUserId: "creator-1",
  displayName: "Deployment runner",
  role: "admin",
  credentialLabel: "Primary",
  expiresAt,
});

const issueSibling = (service: ServiceAccountService, serviceAccountId: string) => service.issueCredential({
  accountId: "account-1",
  workspaceId: "workspace-1",
  actorUserId: "operator-2",
  serviceAccountId,
  label: "Canary",
  expiresAt,
});

describe("ServiceAccountService credential lifecycle", () => {
  it("relabels only the addressed credential and leaves its sibling active", async () => {
    const { audit, repository, service } = createHarness();
    const created = await createServiceAccount(service);
    const sibling = await issueSibling(service, created.account.id);

    const relabeled = await service.relabelCredential({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      credentialId: sibling.credential.id,
      label: "  Canary deployment  ",
      revision: sibling.credential.revision,
    });

    expect(relabeled).toMatchObject({ id: sibling.credential.id, label: "Canary deployment", revision: 2 });
    expect(repository.credentials.get(created.credential.id)).toMatchObject({ label: "Primary", revokedAt: null });
    expect(repository.credentials.get(sibling.credential.id)).toMatchObject({ label: "Canary deployment", revokedAt: null });
    expect(audit.events).toContainEqual(expect.objectContaining({
      eventType: "machine_access.service_credential.relabeled",
      metadata: expect.objectContaining({ credentialId: sibling.credential.id, principalId: created.account.id }),
    }));
  });

  it("revokes one credential idempotently without revoking its sibling", async () => {
    const { audit, repository, service } = createHarness();
    const created = await createServiceAccount(service);
    const sibling = await issueSibling(service, created.account.id);

    const revoked = await service.revokeCredential({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      credentialId: created.credential.id,
      revision: created.credential.revision,
    });
    expect(revoked).toMatchObject({ id: created.credential.id, revocationReason: "explicit" });
    expect(repository.credentials.get(sibling.credential.id)).toMatchObject({ revokedAt: null });

    await service.revokeCredential({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      credentialId: created.credential.id,
    });
    expect(audit.events.filter((event) => event.eventType === "machine_access.service_credential.revoked")).toHaveLength(2);
    expect(repository.credentials.get(sibling.credential.id)).toMatchObject({ revokedAt: null });
  });

  it("keeps overlapping credentials attributable to one principal after a lost issue response", async () => {
    const { service } = createHarness();
    const created = await createServiceAccount(service);
    const issued = await issueSibling(service, created.account.id);

    const listed = await service.listCredentials({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
    });

    expect(issued.secret).toMatch(/^radioso_svc_v1_/);
    expect(listed).toMatchObject({ total: 2 });
    expect(listed.items.map((credential) => credential.id)).toEqual(expect.arrayContaining([
      created.credential.id,
      issued.credential.id,
    ]));
    expect(listed.items.every((credential) => credential.serviceAccountId === created.account.id)).toBe(true);
    expect(listed.items.every((credential) => !("secret" in credential))).toBe(true);
  });

  it("allows one immediate rotation winner and rejects stale concurrent retries", async () => {
    const { repository, service } = createHarness();
    const created = await createServiceAccount(service);
    const input = {
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      credentialId: created.credential.id,
      revision: created.credential.revision,
    };

    const attempts = await Promise.allSettled([
      service.rotateCredential(input),
      service.rotateCredential(input),
    ]);
    const winner = attempts.find((attempt): attempt is PromiseFulfilledResult<{ credential: { id: string; rotatedFromCredentialId: string | null } }> => attempt.status === "fulfilled");
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(winner?.value.credential).toMatchObject({ rotatedFromCredentialId: created.credential.id });
    expect(repository.credentials.get(created.credential.id)).toMatchObject({ revocationReason: "rotated" });

    await expect(service.rotateCredential(input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("denies new and replacement credentials while the parent is disabled or archived", async () => {
    const { service } = createHarness();
    const created = await createServiceAccount(service);
    const disabled = await service.update({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      revision: created.account.revision,
      status: "disabled",
    });

    await expect(issueSibling(service, created.account.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.rotateCredential({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      credentialId: created.credential.id,
      revision: created.credential.revision,
    })).rejects.toMatchObject({ statusCode: 409 });

    const archived = await service.update({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      revision: disabled.revision,
      status: "archived",
    });
    expect(archived.status).toBe("archived");
    await expect(issueSibling(service, created.account.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("uses the current operator role and never depends on the original creator", async () => {
    const { repository, roles, service } = createHarness();
    const created = await createServiceAccount(service);

    roles.set("operator-2", "member");
    await expect(service.update({
      accountId: "account-1",
      workspaceId: "workspace-1",
      actorUserId: "operator-2",
      serviceAccountId: created.account.id,
      revision: created.account.revision,
      role: "admin",
    })).rejects.toMatchObject({ statusCode: 403 });

    roles.set("operator-2", "admin");
    const issued = await issueSibling(service, created.account.id);
    expect(issued.credential.createdByUserId).toBe("operator-2");
    expect(repository.serviceAccounts.get(created.account.id)).toMatchObject({ createdByUserId: "creator-1" });
  });
});
