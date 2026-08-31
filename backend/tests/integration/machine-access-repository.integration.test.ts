import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

import { MachineAccessRepository } from "../../src/db/repositories/machineAccessRepository.js";
import { ServiceAccountService } from "../../src/modules/machineAccess/services/serviceAccountService.js";
import { Database } from "../../src/shared/infra/database.js";
import { createAuditService } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

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
