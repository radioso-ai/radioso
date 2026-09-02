import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { MachineAccessRepository } from "../../src/db/repositories/machineAccessRepository.js";
import { PersonalCredentialService } from "../../src/modules/machineAccess/services/personalCredentialService.js";
import { PersonalCredentialTenureService } from "../../src/modules/machineAccess/services/personalCredentialTenureService.js";
import { ServiceAccountService } from "../../src/modules/machineAccess/services/serviceAccountService.js";
import { Database } from "../../src/shared/infra/database.js";
import { runWithRequestAuditContext } from "../../src/shared/observability/requestAuditContext.js";
import { createAuditService } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((completion) => { resolve = completion; });
  return { promise, resolve };
};

describeIntegration("MachineAccessRepository", () => {
  const database = new Database(integrationDatabaseUrl as string);
  const repository = new MachineAccessRepository(database.kysely);
  const accountId = randomUUID();
  const workspaceId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();

  beforeAll(async () => {
    await database.query("INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)", [accountId, "Access Test", `access-${accountId}@example.com`, "hash"]);
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [userId, `user-${userId}@example.com`, "hash"]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [membershipId, accountId, userId]);
    await database.query("INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4)", [workspaceId, accountId, "Access", `access-${workspaceId}`]);
  });
  afterAll(async () => { await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined); await database.close().catch(() => undefined); });

  it("does not mint a service credential after a concurrent actor-membership removal wins the row lock", async () => {
    const actorId = randomUUID();
    const actorMembershipId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [actorId, `removed-actor-${actorId}@example.com`, "hash"]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [actorMembershipId, accountId, actorId]);
    const deletionHasLock = deferred();
    const releaseDeletion = deferred();
    const deletion = database.kysely.transaction().execute(async (trx) => {
      await trx.deleteFrom("account_memberships").where("id", "=", actorMembershipId).execute();
      deletionHasLock.resolve();
      await releaseDeletion.promise;
    });
    await deletionHasLock.promise;
    const countBefore = await repository.countServiceAccounts(workspaceId);
    const attempt = repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Blocked after removal",
      role: "member",
      createdByUserId: actorId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "must-not-be-returned", tokenPrefix: "radioso_svc_v1_blocked", tokenHash: `blocked-${randomUUID()}` }),
      actorAuthority: { accountId, workspaceId, actorUserId: actorId },
    });
    releaseDeletion.resolve();
    await deletion;
    await expect(attempt).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository.countServiceAccounts(workspaceId)).resolves.toBe(countBefore);
  });

  it("does not issue a service credential after a concurrent actor demotion wins the row lock", async () => {
    const actorId = randomUUID();
    const actorMembershipId = randomUUID();
    await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)", [actorId, `demoted-actor-${actorId}@example.com`, "hash"]);
    await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [actorMembershipId, accountId, actorId]);
    const serviceAccount = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Demotion target",
      role: "member",
      createdByUserId: userId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "initial", tokenPrefix: "radioso_svc_v1_initial", tokenHash: `initial-${randomUUID()}` }),
    });
    expect(serviceAccount).not.toBeNull();
    const demotionHasLock = deferred();
    const releaseDemotion = deferred();
    const demotion = database.kysely.transaction().execute(async (trx) => {
      await trx.updateTable("account_memberships").set({ role: "member" }).where("id", "=", actorMembershipId).execute();
      demotionHasLock.resolve();
      await releaseDemotion.promise;
    });
    await demotionHasLock.promise;
    const attempt = repository.createServiceCredentialWithinLimit({
      accountId,
      workspaceId,
      serviceAccountId: serviceAccount!.account.id,
      label: "must not issue",
      expiresAt: new Date(Date.now() + 86_400_000),
      createdByUserId: actorId,
      now: new Date(),
      limit: 5,
      issueSecret: () => ({ secret: "must-not-be-returned", tokenPrefix: "radioso_svc_v1_demoted", tokenHash: `demoted-${randomUUID()}` }),
      actorAuthority: { accountId, workspaceId, actorUserId: actorId },
    });
    releaseDemotion.resolve();
    await demotion;
    await expect(attempt).rejects.toMatchObject({ statusCode: 403 });
    await expect(repository.countActiveServiceCredentials(serviceAccount!.account.id)).resolves.toBe(1);
  });

  it("persists only a verifier and conditionally creates one rotation winner", async () => {
    const created = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Runner",
      role: "member",
      createdByUserId: userId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "returned-once", tokenPrefix: "radioso_svc_v1_abcd", tokenHash: `verifier-only-${randomUUID()}` }),
    });
    expect(created).not.toBeNull();
    const credential = created!.credential;
    const row = await database.queryOne<{ token_hash: string; encrypted_token?: string }>("SELECT token_hash FROM api_credentials WHERE id = $1", [credential.id]);
    expect(row.token_hash).toBe(credential.tokenHash);
    expect(row).not.toHaveProperty("encrypted_token");
    const [first, second] = await Promise.all([
      repository.replaceCredential({ credentialId: credential.id, expectedRevision: credential.revision, label: "rotated", tokenPrefix: "radioso_svc_v1_a", tokenHash: `winner-${randomUUID()}`, createdByUserId: userId }),
      repository.replaceCredential({ credentialId: credential.id, expectedRevision: credential.revision, label: "rotated", tokenPrefix: "radioso_svc_v1_b", tokenHash: `loser-${randomUUID()}`, createdByUserId: userId }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("keeps credential pagination bounded and stable by creation time then id", async () => {
    const created = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Pagination target",
      role: "member",
      createdByUserId: userId,
      credentialLabel: "credential-0",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "page-0", tokenPrefix: "radioso_svc_v1_page", tokenHash: `page-0-${randomUUID()}` }),
    });
    expect(created).not.toBeNull();
    for (const index of [1, 2, 3, 4]) {
      await expect(repository.createServiceCredentialWithinLimit({
        accountId,
        workspaceId,
        serviceAccountId: created!.account.id,
        label: `credential-${index}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdByUserId: userId,
        now: new Date(),
        limit: 5,
        issueSecret: () => ({ secret: `page-${index}`, tokenPrefix: "radioso_svc_v1_page", tokenHash: `page-${index}-${randomUUID()}` }),
      })).resolves.toMatchObject({ status: "created" });
    }

    const list = (page: number) => repository.listCredentials({
      workspaceId,
      serviceAccountId: created!.account.id,
      kind: "service",
      limit: 2,
      page,
    });
    const [firstPage, repeatFirstPage, secondPage, thirdPage, outOfBounds] = await Promise.all([
      list(1), list(1), list(2), list(3), list(4),
    ]);
    const expected = await database.query<{ id: string }>(
      "SELECT id FROM api_credentials WHERE service_account_id = $1 ORDER BY created_at DESC, id DESC",
      [created!.account.id],
    );

    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(2);
    expect(thirdPage).toHaveLength(1);
    expect(outOfBounds).toEqual([]);
    expect(firstPage.map((credential) => credential.id)).toEqual(repeatFirstPage.map((credential) => credential.id));
    expect([...firstPage, ...secondPage, ...thirdPage].map((credential) => credential.id))
      .toEqual(expected.map((credential) => credential.id));
  });

  it("enforces personal quota atomically before issuing a secret", async () => {
    let secretIssues = 0;
    const issue = () => {
      secretIssues += 1;
      return { secret: `secret-${secretIssues}`, tokenPrefix: "radioso_pat_v1_test", tokenHash: `personal-${randomUUID()}` };
    };
    const input = {
      accountId,
      workspaceId,
      ownerUserId: userId,
      accessTenureMembershipId: membershipId,
      roleCeiling: "member" as const,
      label: "personal",
      expiresAt: new Date(Date.now() + 86_400_000),
      createdByUserId: userId,
      now: new Date(),
      limit: 1,
      issueSecret: issue,
    };
    const [first, second] = await Promise.all([
      repository.createPersonalWithinLimit(input),
      repository.createPersonalWithinLimit(input),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(secretIssues).toBe(1);
  });

  it("archives with optimistic revision and revokes all child credentials atomically", async () => {
    const created = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Archive target",
      role: "admin",
      createdByUserId: userId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "archive", tokenPrefix: "radioso_svc_v1_archive", tokenHash: `archive-${randomUUID()}` }),
    });
    expect(created).not.toBeNull();
    const archived = await repository.mutateServiceAccount({
      id: created!.account.id,
      workspaceId,
      expectedRevision: 1,
      actorUserId: userId,
      targetStatus: "archived",
      now: new Date(),
    });
    expect(archived).toMatchObject({ status: "updated", invalidatedCredentialIds: [created!.credential.id] });
    expect(await repository.findCredential(created!.credential.id)).toMatchObject({ revokedAt: expect.any(Date) });
    expect(await repository.mutateServiceAccount({
      id: created!.account.id,
      workspaceId,
      expectedRevision: 1,
      actorUserId: userId,
      targetStatus: "enabled",
      now: new Date(),
    })).toEqual({ status: "conflict" });
  });

  it("persists archive and rotation audits in the lifecycle transaction, rolling state back when audit persistence fails", async () => {
    const created = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Audited lifecycle target",
      role: "admin",
      createdByUserId: userId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "audited", tokenPrefix: "radioso_svc_v1_audited", tokenHash: `audited-${randomUUID()}` }),
    });
    expect(created).not.toBeNull();
    const service = new ServiceAccountService({
      repository,
      audit: createAuditService(),
      accountAccess: { requirePermission: async () => undefined, resolveWorkspaceRole: async () => "admin" } as never,
    });

    const rotation = await service.rotateCredential({
      accountId, workspaceId, actorUserId: userId, serviceAccountId: created!.account.id,
      credentialId: created!.credential.id, revision: created!.credential.revision,
    });
    const [rotationAudit] = await database.query<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM audit_events WHERE event_type = 'machine_access.service_credential.rotated' AND workspace_id = $1 ORDER BY created_at DESC LIMIT 1",
      [workspaceId],
    );
    expect(rotationAudit?.metadata_json).toMatchObject({ credentialId: rotation.credential.id, rotatedFromCredentialId: created!.credential.id });

    await database.execute(`
      CREATE OR REPLACE FUNCTION machine_access_reject_archive_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'machine_access.service_account.archived' THEN
          RAISE EXCEPTION 'required audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await database.execute("DROP TRIGGER IF EXISTS machine_access_reject_archive_audit ON audit_events");
    await database.execute("CREATE TRIGGER machine_access_reject_archive_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION machine_access_reject_archive_audit()");
    try {
      await expect(service.update({
        accountId, workspaceId, actorUserId: userId, serviceAccountId: created!.account.id,
        revision: created!.account.revision, status: "archived",
      })).rejects.toThrow(/required audit unavailable/i);
      expect(await repository.findServiceAccount(created!.account.id)).toMatchObject({ status: "enabled" });
      expect(await repository.findCredential(rotation.credential.id)).toMatchObject({ revokedAt: null });
    } finally {
      await database.execute("DROP TRIGGER IF EXISTS machine_access_reject_archive_audit ON audit_events");
      await database.execute("DROP FUNCTION IF EXISTS machine_access_reject_archive_audit()");
    }

    const archived = await service.update({
      accountId, workspaceId, actorUserId: userId, serviceAccountId: created!.account.id,
      revision: created!.account.revision, status: "archived",
    });
    const childEvents = await database.query<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM audit_events WHERE event_type = 'machine_access.service_credential.invalidated' AND workspace_id = $1",
      [workspaceId],
    );
    expect(archived.status).toBe("archived");
    expect(childEvents.some((event) => event.metadata_json.credentialId === rotation.credential.id)).toBe(true);
  });

  it("rolls back personal issue, relabel, and revoke with their audit writes and preserves request correlation", async () => {
    const service = new PersonalCredentialService({
      repository,
      audit: createAuditService(),
      accountAccess: {
        requirePermission: async () => undefined,
        requireActiveMembership: async () => ({ id: membershipId, accountId, userId, role: "admin", status: "active" }),
        resolveWorkspaceRole: async () => "admin",
      } as never,
    });
    const createAuditFailureTrigger = async (eventType: string) => {
      await database.execute(`
        CREATE OR REPLACE FUNCTION machine_access_reject_personal_audit()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.event_type = '${eventType}' THEN RAISE EXCEPTION 'required audit unavailable'; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await database.execute("DROP TRIGGER IF EXISTS machine_access_reject_personal_audit ON audit_events");
      await database.execute("CREATE TRIGGER machine_access_reject_personal_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION machine_access_reject_personal_audit()");
    };
    const removeAuditFailureTrigger = async () => {
      await database.execute("DROP TRIGGER IF EXISTS machine_access_reject_personal_audit ON audit_events");
      await database.execute("DROP FUNCTION IF EXISTS machine_access_reject_personal_audit()");
    };
    const issueInput = { accountId, workspaceId, userId, label: "Audited personal", roleCeiling: "member" as const, expiresAt: new Date(Date.now() + 86_400_000) };
    try {
      await createAuditFailureTrigger("machine_access.personal_credential.issued");
      await expect(service.issue(issueInput)).rejects.toThrow(/required audit unavailable/i);
      expect((await repository.listCredentials({ workspaceId, ownerUserId: userId, kind: "personal", limit: 100 })).filter((credential) => credential.label === issueInput.label)).toEqual([]);
      await removeAuditFailureTrigger();

      const requestId = `request-${randomUUID()}`;
      const issued = await runWithRequestAuditContext({ requestId }, () => service.issue(issueInput));
      const [issuedAudit] = await database.query<{ metadata_json: Record<string, unknown> }>(
        "SELECT metadata_json FROM audit_events WHERE event_type = 'machine_access.personal_credential.issued' AND metadata_json->>'credentialId' = $1",
        [issued.credential.id],
      );
      expect(issuedAudit?.metadata_json).toMatchObject({ requestId, credentialId: issued.credential.id, principalKind: "user" });
      expect(JSON.stringify(issuedAudit?.metadata_json)).not.toMatch(/secret|authorization|header|error/i);

      await createAuditFailureTrigger("machine_access.personal_credential.relabeled");
      await expect(service.relabel({ ...issueInput, credentialId: issued.credential.id, label: "Should rollback", revision: issued.credential.revision })).rejects.toThrow(/required audit unavailable/i);
      expect(await repository.findCredential(issued.credential.id)).toMatchObject({ label: issueInput.label, revokedAt: null });
      await removeAuditFailureTrigger();

      await createAuditFailureTrigger("machine_access.personal_credential.revoked");
      await expect(service.revoke({ accountId, workspaceId, actorUserId: userId, credentialId: issued.credential.id, revision: issued.credential.revision })).rejects.toThrow(/required audit unavailable/i);
      expect(await repository.findCredential(issued.credential.id)).toMatchObject({ revokedAt: null });
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  it("rolls back service-account creation and service credential issue, relabel, and revoke with audit persistence", async () => {
    const service = new ServiceAccountService({
      repository,
      audit: createAuditService(),
      accountAccess: { requirePermission: async () => undefined, resolveWorkspaceRole: async () => "admin" } as never,
    });
    const createAuditFailureTrigger = async (eventType: string) => {
      await database.execute(`
        CREATE OR REPLACE FUNCTION machine_access_reject_service_audit()
        RETURNS trigger AS $$
        BEGIN
          IF NEW.event_type = '${eventType}' THEN RAISE EXCEPTION 'required audit unavailable'; END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await database.execute("DROP TRIGGER IF EXISTS machine_access_reject_service_audit ON audit_events");
      await database.execute("CREATE TRIGGER machine_access_reject_service_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION machine_access_reject_service_audit()");
    };
    const removeAuditFailureTrigger = async () => {
      await database.execute("DROP TRIGGER IF EXISTS machine_access_reject_service_audit ON audit_events");
      await database.execute("DROP FUNCTION IF EXISTS machine_access_reject_service_audit()");
    };
    const createInput = { accountId, workspaceId, actorUserId: userId, displayName: "Required audit", role: "member" as const, credentialLabel: "primary", expiresAt: new Date(Date.now() + 86_400_000) };
    try {
      await createAuditFailureTrigger("machine_access.service_account.created");
      await expect(service.createWithCredential(createInput)).rejects.toThrow(/required audit unavailable/i);
      expect((await repository.listServiceAccounts({ workspaceId, limit: 100 })).some((account) => account.displayName === createInput.displayName)).toBe(false);
      await removeAuditFailureTrigger();

      const created = await service.createWithCredential(createInput);
      await createAuditFailureTrigger("machine_access.service_credential.issued");
      await expect(service.issueCredential({ ...createInput, serviceAccountId: created.account.id, label: "second" })).rejects.toThrow(/required audit unavailable/i);
      expect(await repository.countActiveServiceCredentials(created.account.id)).toBe(1);
      await removeAuditFailureTrigger();

      await createAuditFailureTrigger("machine_access.service_credential.relabeled");
      await expect(service.relabelCredential({ ...createInput, serviceAccountId: created.account.id, credentialId: created.credential.id, label: "renamed", revision: created.credential.revision })).rejects.toThrow(/required audit unavailable/i);
      expect(await repository.findCredential(created.credential.id)).toMatchObject({ label: "Primary", revokedAt: null });
      await removeAuditFailureTrigger();

      await createAuditFailureTrigger("machine_access.service_credential.revoked");
      await expect(service.revokeCredential({ ...createInput, serviceAccountId: created.account.id, credentialId: created.credential.id, revision: created.credential.revision })).rejects.toThrow(/required audit unavailable/i);
      expect(await repository.findCredential(created.credential.id)).toMatchObject({ revokedAt: null });
    } finally {
      await removeAuditFailureTrigger();
    }
  });

  it("serializes personal issue and rotation with membership termination so no active credential escapes invalidation", async () => {
    const makePersonalServices = async () => {
      const raceUserId = randomUUID();
      const raceMembershipId = randomUUID();
      await database.query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')", [raceUserId, `race-${raceUserId}@example.com`]);
      await database.query("INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'admin', 'active')", [raceMembershipId, accountId, raceUserId]);
      const accountAccess = {
        requirePermission: async () => undefined,
        requireActiveMembership: async () => ({ id: raceMembershipId, accountId, userId: raceUserId, role: "admin", status: "active" }),
        resolveWorkspaceRole: async () => "admin",
      } as never;
      return {
        userId: raceUserId,
        membershipId: raceMembershipId,
        personal: new PersonalCredentialService({ repository, audit: createAuditService(), accountAccess }),
        tenure: new PersonalCredentialTenureService({ repository, audit: createAuditService() }),
      };
    };
    const first = await makePersonalServices();
    const issue = first.personal.issue({ accountId, workspaceId, userId: first.userId, label: "Issue race", roleCeiling: "member", expiresAt: new Date(Date.now() + 86_400_000) });
    await database.query("UPDATE account_memberships SET status = 'inactive' WHERE id = $1", [first.membershipId]);
    const firstRace = await Promise.allSettled([issue, first.tenure.endMembership({ accountId, membershipId: first.membershipId })]);
    expect(firstRace[1]).toMatchObject({ status: "fulfilled" });
    const firstCredentials = await database.query<{ id: string; revoked_at: Date | null }>(
      "SELECT id, revoked_at FROM api_credentials WHERE access_tenure_membership_id = $1", [first.membershipId],
    );
    expect(firstCredentials.every((credential) => credential.revoked_at !== null)).toBe(true);

    const second = await makePersonalServices();
    const original = await second.personal.issue({ accountId, workspaceId, userId: second.userId, label: "Rotation race", roleCeiling: "member", expiresAt: new Date(Date.now() + 86_400_000) });
    const rotate = second.personal.rotate({ accountId, workspaceId, userId: second.userId, credentialId: original.credential.id, revision: original.credential.revision });
    await database.query("UPDATE account_memberships SET status = 'inactive' WHERE id = $1", [second.membershipId]);
    const secondRace = await Promise.allSettled([rotate, second.tenure.endMembership({ accountId, membershipId: second.membershipId })]);
    if (secondRace[1]?.status === "rejected") throw secondRace[1].reason;
    const secondCredentials = await database.query<{ id: string; revoked_at: Date | null; revocation_reason: string | null }>(
      "SELECT id, revoked_at, revocation_reason FROM api_credentials WHERE access_tenure_membership_id = $1", [second.membershipId],
    );
    expect(secondCredentials).not.toHaveLength(0);
    expect(secondCredentials.every((credential) => credential.revoked_at !== null)).toBe(true);
    const invalidationIds = await database.query<{ credential_id: string }>(
      `SELECT metadata_json->>'credentialId' AS credential_id
       FROM audit_events
       WHERE event_type = 'machine_access.personal_credential.invalidated'
         AND metadata_json->>'reason' = 'membership_ended'`,
    );
    const invalidatedAtTermination = secondCredentials
      .filter((credential) => credential.revocation_reason === "membership_ended")
      .map((credential) => credential.id)
      .sort();
    expect(invalidationIds.map((event) => event.credential_id).filter((id) => invalidatedAtTermination.includes(id)).sort())
      .toEqual(invalidatedAtTermination);
  });

  it("coalesces credential and service last-use separately, then rolls both back when aggregate persistence fails", async () => {
    const created = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Last-use target",
      role: "member",
      createdByUserId: userId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "last-use", tokenPrefix: "radioso_svc_v1_last", tokenHash: `last-use-${randomUUID()}` }),
    });
    expect(created).not.toBeNull();
    const sibling = await repository.createServiceCredentialWithinLimit({
      accountId,
      workspaceId,
      serviceAccountId: created!.account.id,
      label: "sibling",
      expiresAt: new Date(Date.now() + 86_400_000),
      createdByUserId: userId,
      now: new Date("2026-08-31T00:00:00.000Z"),
      limit: 5,
      issueSecret: () => ({ secret: "last-use-sibling", tokenPrefix: "radioso_svc_v1_last", tokenHash: `last-use-sibling-${randomUUID()}` }),
    });
    expect(sibling.status).toBe("created");
    if (sibling.status !== "created") throw new Error("Expected test service credential");

    const firstUse = new Date("2026-08-31T00:00:00.000Z");
    const withinWindow = new Date(firstUse.getTime() + 4 * 60 * 1_000);
    const afterWindow = new Date(firstUse.getTime() + 5 * 60 * 1_000 + 1_000);
    await repository.touchCredentialUse({
      credentialId: created!.credential.id,
      serviceAccountId: created!.account.id,
      at: firstUse,
    });
    await repository.touchCredentialUse({
      credentialId: created!.credential.id,
      serviceAccountId: created!.account.id,
      at: withinWindow,
    });
    await repository.touchCredentialUse({
      credentialId: sibling.credential.id,
      serviceAccountId: created!.account.id,
      at: withinWindow,
    });

    expect(await repository.findCredential(created!.credential.id)).toMatchObject({ lastUsedAt: firstUse });
    expect(await repository.findCredential(sibling.credential.id)).toMatchObject({ lastUsedAt: withinWindow });
    expect(await repository.findServiceAccount(created!.account.id)).toMatchObject({ lastUsedAt: firstUse });

    await repository.touchCredentialUse({
      credentialId: created!.credential.id,
      serviceAccountId: created!.account.id,
      at: afterWindow,
    });
    expect(await repository.findCredential(created!.credential.id)).toMatchObject({ lastUsedAt: afterWindow });
    expect(await repository.findServiceAccount(created!.account.id)).toMatchObject({ lastUsedAt: afterWindow });

    const removeFailureTrigger = await installLastUseFailureTrigger(created!.account.id);
    try {
      await expect(repository.touchCredentialUse({
        credentialId: sibling.credential.id,
        serviceAccountId: created!.account.id,
        at: new Date(afterWindow.getTime() + 5 * 60 * 1_000 + 1_000),
      })).rejects.toThrow(/last-use aggregate unavailable/i);
      expect(await repository.findCredential(sibling.credential.id)).toMatchObject({ lastUsedAt: withinWindow });
      expect(await repository.findServiceAccount(created!.account.id)).toMatchObject({ lastUsedAt: afterWindow });
    } finally {
      await removeFailureTrigger();
    }
  });

  it("claims each expiry-warning threshold exactly when a credential enters its warning window", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1_000;
    const createCredential = async (label: string, expiresAt: Date) => {
      const created = await repository.createServiceAccountWithinLimit({
        accountId,
        workspaceId,
        displayName: `Expiry warning ${label}`,
        role: "member",
        createdByUserId: userId,
        credentialLabel: label,
        expiresAt,
        limit: 50,
        issueSecret: () => ({
          secret: `expiry-warning-${label}`,
          tokenPrefix: "radioso_svc_v1_expiry",
          tokenHash: `expiry-warning-${label}-${randomUUID()}`,
        }),
      });
      expect(created).not.toBeNull();
      if (!created) throw new Error("Expected expiry-warning credential");
      return created.credential;
    };

    const atThirtyDays = await createCredential("thirty", new Date(now.getTime() + 30 * dayMs));
    const atSevenDays = await createCredential("seven", new Date(now.getTime() + 7 * dayMs));
    const atOneDay = await createCredential("one", new Date(now.getTime() + dayMs));
    const outsideWindow = await createCredential("outside", new Date(now.getTime() + 30 * dayMs + 1));
    const expired = await createCredential("expired", now);

    const claims = await repository.claimExpiryWarnings(now);
    const thresholdsFor = (credentialId: string) => claims
      .filter((claim) => claim.credentialId === credentialId)
      .map((claim) => claim.thresholdDays)
      .sort((left, right) => left - right);

    expect(thresholdsFor(atThirtyDays.id)).toEqual([30]);
    expect(thresholdsFor(atSevenDays.id)).toEqual([7, 30]);
    expect(thresholdsFor(atOneDay.id)).toEqual([1, 7, 30]);
    expect(thresholdsFor(outsideWindow.id)).toEqual([]);
    expect(thresholdsFor(expired.id)).toEqual([]);
    expect((await repository.claimExpiryWarnings(now)).filter((claim) =>
      [atThirtyDays.id, atSevenDays.id, atOneDay.id, outsideWindow.id, expired.id].includes(claim.credentialId),
    )).toEqual([]);
  });

  it("never persists or omits an invalidation audit for a replacement raced with archive", async () => {
    const created = await repository.createServiceAccountWithinLimit({
      workspaceId,
      accountId,
      displayName: "Archive rotation race target",
      role: "admin",
      createdByUserId: userId,
      credentialLabel: "primary",
      expiresAt: new Date(Date.now() + 86_400_000),
      limit: 50,
      issueSecret: () => ({ secret: "race", tokenPrefix: "radioso_svc_v1_race", tokenHash: `race-${randomUUID()}` }),
    });
    expect(created).not.toBeNull();

    const audit = createAuditService();
    const service = new ServiceAccountService({
      repository,
      audit,
      accountAccess: {
        requirePermission: async () => undefined,
        resolveWorkspaceRole: async () => "admin",
      } as never,
    });
    const removeRaceTriggers = await installArchiveRotationRaceTriggers({
      credentialId: created!.credential.id,
      serviceAccountId: created!.account.id,
    });

    try {
      const archive = service.update({
        accountId,
        workspaceId,
        actorUserId: userId,
        serviceAccountId: created!.account.id,
        revision: created!.account.revision,
        status: "archived",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rotate = service.rotateCredential({
        accountId,
        workspaceId,
        actorUserId: userId,
        serviceAccountId: created!.account.id,
        credentialId: created!.credential.id,
        revision: created!.credential.revision,
      });

      await expect(archive).resolves.toMatchObject({ status: "archived" });
      await expect(rotate).rejects.toMatchObject({ statusCode: 409 });

      const persistedCredentials = await repository.listCredentials({
        workspaceId,
        serviceAccountId: created!.account.id,
        kind: "service",
        limit: 10,
      });
      expect(persistedCredentials).toHaveLength(1);
      expect(persistedCredentials.every((credential) => credential.revokedAt !== null)).toBe(true);
      const invalidatedCredentialIds = audit.events
        .filter((event) => event.eventType === "machine_access.service_credential.invalidated")
        .map((event) => String(event.metadata?.credentialId));
      expect(invalidatedCredentialIds.sort()).toEqual(persistedCredentials.map((credential) => credential.id).sort());
    } finally {
      await removeRaceTriggers();
    }
  });
});

const installArchiveRotationRaceTriggers = async (input: { credentialId: string; serviceAccountId: string }): Promise<() => Promise<void>> => {
  const raceDatabase = new Database(integrationDatabaseUrl as string);
  try {
    await raceDatabase.execute(`
      CREATE OR REPLACE FUNCTION machine_access_archive_race_pause_account()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${input.serviceAccountId}'::uuid AND NEW.status = 'archived' THEN
          PERFORM pg_sleep(0.2);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await raceDatabase.execute(`
      CREATE OR REPLACE FUNCTION machine_access_archive_race_pause_credential()
      RETURNS trigger AS $$
      BEGIN
        IF OLD.id = '${input.credentialId}'::uuid AND NEW.revocation_reason = 'rotated' THEN
          PERFORM pg_sleep(0.7);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await raceDatabase.execute("DROP TRIGGER IF EXISTS machine_access_archive_race_pause_account ON workspace_service_accounts");
    await raceDatabase.execute("DROP TRIGGER IF EXISTS machine_access_archive_race_pause_credential ON api_credentials");
    await raceDatabase.execute("CREATE TRIGGER machine_access_archive_race_pause_account BEFORE UPDATE ON workspace_service_accounts FOR EACH ROW EXECUTE FUNCTION machine_access_archive_race_pause_account()");
    await raceDatabase.execute("CREATE TRIGGER machine_access_archive_race_pause_credential BEFORE UPDATE ON api_credentials FOR EACH ROW EXECUTE FUNCTION machine_access_archive_race_pause_credential()");
  } finally {
    await raceDatabase.close();
  }

  return async () => {
    const cleanupDatabase = new Database(integrationDatabaseUrl as string);
    try {
      await cleanupDatabase.execute("DROP TRIGGER IF EXISTS machine_access_archive_race_pause_account ON workspace_service_accounts");
      await cleanupDatabase.execute("DROP TRIGGER IF EXISTS machine_access_archive_race_pause_credential ON api_credentials");
      await cleanupDatabase.execute("DROP FUNCTION IF EXISTS machine_access_archive_race_pause_account()");
      await cleanupDatabase.execute("DROP FUNCTION IF EXISTS machine_access_archive_race_pause_credential()");
    } finally {
      await cleanupDatabase.close();
    }
  };
};

const installLastUseFailureTrigger = async (serviceAccountId: string): Promise<() => Promise<void>> => {
  const triggerDatabase = new Database(integrationDatabaseUrl as string);
  try {
    await triggerDatabase.execute(`
      CREATE OR REPLACE FUNCTION machine_access_last_use_failure()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${serviceAccountId}'::uuid THEN
          RAISE EXCEPTION 'last-use aggregate unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await triggerDatabase.execute("DROP TRIGGER IF EXISTS machine_access_last_use_failure ON workspace_service_accounts");
    await triggerDatabase.execute("CREATE TRIGGER machine_access_last_use_failure BEFORE UPDATE ON workspace_service_accounts FOR EACH ROW EXECUTE FUNCTION machine_access_last_use_failure()");
  } finally {
    await triggerDatabase.close();
  }

  return async () => {
    const cleanupDatabase = new Database(integrationDatabaseUrl as string);
    try {
      await cleanupDatabase.execute("DROP TRIGGER IF EXISTS machine_access_last_use_failure ON workspace_service_accounts");
      await cleanupDatabase.execute("DROP FUNCTION IF EXISTS machine_access_last_use_failure()");
    } finally {
      await cleanupDatabase.close();
    }
  };
};
