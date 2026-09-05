import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";

import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { MachineAccessRepository } from "../../src/db/repositories/machineAccessRepository.js";
import { PersonalCredentialLifecycleRepository } from "../../src/db/repositories/personalCredentialLifecycleRepository.js";
import { WorkspaceGrantRepository } from "../../src/db/repositories/workspaceGrantRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { PersonalCredentialService } from "../../src/modules/machineAccess/services/personalCredentialService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import { Database } from "../../src/shared/infra/database.js";
import { runWithRequestAuditContext } from "../../src/shared/observability/requestAuditContext.js";
import { createAuditService } from "../support/fakes.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

interface Fixture {
  accountId: string;
  ownerId: string;
  memberId: string;
  memberMembershipId: string;
  workspaceId: string;
  secondaryWorkspaceId: string;
  access: AccountAccessService;
  personal: PersonalCredentialService;
  workspace: WorkspaceService;
  auth: AuthService;
}

describeIntegration("Personal credential lifecycle deletion", () => {
  const database = new Database(integrationDatabaseUrl);
  const accountIds: string[] = [];
  const machineAccessRepository = new MachineAccessRepository(database.kysely);
  const lifecycle = new PersonalCredentialLifecycleRepository(database.kysely);
  const membershipRepository = new AccountMembershipRepository(database.kysely);
  const workspaceGrantRepository = new WorkspaceGrantRepository(database.kysely);
  const workspaceRepository = new WorkspaceRepository(database.kysely);
  const accountRepository = new AccountRepository(database.kysely);

  const fixture = async (): Promise<Fixture> => {
    const accountId = randomUUID();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const ownerMembershipId = randomUUID();
    const memberMembershipId = randomUUID();
    const workspaceId = randomUUID();
    const secondaryWorkspaceId = randomUUID();
    accountIds.push(accountId);
    await database.query(
      "INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
      [accountId, "Lifecycle test", `lifecycle-${accountId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3), ($4, $5, $6)",
      [ownerId, `owner-${ownerId}@example.com`, "hash", memberId, `member-${memberId}@example.com`, "hash"],
    );
    await database.query(
      "INSERT INTO account_memberships (id, account_id, user_id, role, status) VALUES ($1, $2, $3, 'owner', 'active'), ($4, $2, $5, 'member', 'active')",
      [ownerMembershipId, accountId, ownerId, memberMembershipId, memberId],
    );
    await database.query(
      "INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4), ($5, $2, $6, $7)",
      [workspaceId, accountId, "Primary", `life-${workspaceId}`, secondaryWorkspaceId, "Secondary", `life-${secondaryWorkspaceId}`],
    );

    const audit = createAuditService();
    const access = new AccountAccessService(
      membershipRepository,
      audit,
      workspaceGrantRepository,
      workspaceRepository,
      undefined,
      lifecycle,
    );
    const personal = new PersonalCredentialService({ repository: machineAccessRepository, accountAccess: access, audit });
    const workspace = new WorkspaceService(workspaceRepository, audit, membershipRepository, undefined, lifecycle);
    const auth = new AuthService({
      env: {} as never,
      accountRepository,
      userRepository: {} as never,
      sessionRepository: {} as never,
      federatedIdentityRepository: {} as never,
      workspaceService: workspace,
      accountAccessService: access,
      accountInvitationService: {} as never,
      organizationProvisioner: {} as never,
      auditService: audit,
      personalCredentialLifecycle: lifecycle,
    });
    return {
      accountId, ownerId, memberId, memberMembershipId, workspaceId, secondaryWorkspaceId,
      access, personal, workspace, auth,
    };
  };

  const issue = (input: Pick<Fixture, "personal" | "accountId" | "workspaceId" | "memberId">) => input.personal.issue({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    userId: input.memberId,
    label: "personal lifecycle test",
    roleCeiling: "member",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  });

  afterAll(async () => {
    for (const accountId of accountIds) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  });

  it("serializes personal issue and rotation against actual membership removal, and persists sanitized correlation metadata", async () => {
    const current = await fixture();
    const first = await issue(current);
    const requestId = `lifecycle-${randomUUID()}`;

    const [rotation, removal] = await Promise.allSettled([
      current.personal.rotate({
        accountId: current.accountId,
        workspaceId: current.workspaceId,
        userId: current.memberId,
        credentialId: first.credential.id,
        revision: first.credential.revision,
      }),
      runWithRequestAuditContext({ requestId }, () => current.access.removeUserAccess({
        accountId: current.accountId,
        actorUserId: current.ownerId,
        membershipId: current.memberMembershipId,
      })),
    ]);

    expect(removal.status).toBe("fulfilled");
    expect(rotation.status === "fulfilled" || rotation.status === "rejected").toBe(true);
    const active = await database.query<{ id: string }>(
      "SELECT id FROM api_credentials WHERE access_tenure_membership_id = $1 AND revoked_at IS NULL",
      [current.memberMembershipId],
    );
    expect(active).toEqual([]);
    const [parentAudit] = await database.query<{ metadata_json: Record<string, unknown> }>(
      "SELECT metadata_json FROM audit_events WHERE event_type = 'account.membership.remove' AND account_id = $1 ORDER BY created_at DESC LIMIT 1",
      [current.accountId],
    );
    expect(parentAudit.metadata_json).toEqual(expect.objectContaining({
      actorUserId: current.ownerId,
      removedUserId: current.memberId,
      targetMembershipId: current.memberMembershipId,
    }));
    expect(Object.keys(parentAudit.metadata_json)).toEqual(expect.arrayContaining([
      "actorUserId", "removedUserId", "targetMembershipId",
    ]));
    const invalidations = await database.query<{ id: string; metadata_json: Record<string, unknown> }>(
      "SELECT id, metadata_json FROM audit_events WHERE event_type = 'machine_access.personal_credential.invalidated' AND metadata_json->>'reason' = 'membership_ended' AND account_id = $1",
      [current.accountId],
    );
    expect(invalidations.length).toBeGreaterThan(0);
    expect(invalidations.at(-1)?.metadata_json).toMatchObject({ requestId });
  });

  it("serializes personal rotation against actual workspace deletion with no surviving credential", async () => {
    const current = await fixture();
    const first = await issue(current);

    const [rotation, deletion] = await Promise.allSettled([
      current.personal.rotate({
        accountId: current.accountId,
        workspaceId: current.workspaceId,
        userId: current.memberId,
        credentialId: first.credential.id,
        revision: first.credential.revision,
      }),
      current.workspace.delete(current.workspaceId, current.accountId, current.ownerId),
    ]);

    if (deletion.status === "rejected") throw deletion.reason;
    expect(rotation.status === "fulfilled" || rotation.status === "rejected").toBe(true);
    const remaining = await database.query<{ id: string }>("SELECT id FROM api_credentials WHERE workspace_id = $1", [current.workspaceId]);
    expect(remaining).toEqual([]);
    const invalidations = await database.query<{ id: string }>(
      "SELECT id FROM audit_events WHERE event_type = 'machine_access.personal_credential.invalidated' AND metadata_json->>'reason' = 'workspace_deleted'",
    );
    expect(invalidations.length).toBeGreaterThan(0);
  });

  it("serializes personal rotation against actual account deletion with no surviving account", async () => {
    const current = await fixture();
    const first = await current.personal.issue({
      accountId: current.accountId,
      workspaceId: current.workspaceId,
      userId: current.ownerId,
      label: "owner lifecycle test",
      roleCeiling: "member",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });

    const [rotation, deletion] = await Promise.allSettled([
      current.personal.rotate({
        accountId: current.accountId,
        workspaceId: current.workspaceId,
        userId: current.ownerId,
        credentialId: first.credential.id,
        revision: first.credential.revision,
      }),
      current.auth.deleteOrganization({ accountId: current.accountId, userId: current.ownerId }),
    ]);

    if (deletion.status === "rejected") throw deletion.reason;
    expect(rotation.status === "fulfilled" || rotation.status === "rejected").toBe(true);
    const account = await database.query<{ id: string }>("SELECT id FROM accounts WHERE id = $1", [current.accountId]);
    expect(account).toEqual([]);
    const invalidations = await database.query<{ id: string }>(
      "SELECT id FROM audit_events WHERE event_type = 'machine_access.personal_credential.invalidated' AND metadata_json->>'reason' = 'account_deleted'",
    );
    expect(invalidations.length).toBeGreaterThan(0);
  });

  it("rolls back membership removal, credential invalidation, and its required audit together when audit persistence fails", async () => {
    const current = await fixture();
    const credential = await issue(current);
    await database.execute(`
      CREATE OR REPLACE FUNCTION reject_membership_lifecycle_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'account.membership.remove' THEN
          RAISE EXCEPTION 'required lifecycle audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await database.execute("DROP TRIGGER IF EXISTS reject_membership_lifecycle_audit ON audit_events");
    await database.execute("CREATE TRIGGER reject_membership_lifecycle_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_membership_lifecycle_audit()");
    try {
      await expect(current.access.removeUserAccess({
        accountId: current.accountId,
        actorUserId: current.ownerId,
        membershipId: current.memberMembershipId,
      })).rejects.toThrow(/required lifecycle audit unavailable/i);
      await expect(membershipRepository.findById(current.memberMembershipId)).resolves.toMatchObject({ status: "active" });
      await expect(machineAccessRepository.findCredential(credential.credential.id)).resolves.toMatchObject({ revokedAt: null });
    } finally {
      await database.execute("DROP TRIGGER IF EXISTS reject_membership_lifecycle_audit ON audit_events");
      await database.execute("DROP FUNCTION IF EXISTS reject_membership_lifecycle_audit()");
    }
  });

  it("rolls back actual account deletion and credential invalidation when its required audit fails", async () => {
    const current = await fixture();
    const credential = await current.personal.issue({
      accountId: current.accountId,
      workspaceId: current.workspaceId,
      userId: current.ownerId,
      label: "account rollback test",
      roleCeiling: "member",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    });
    await database.execute(`
      CREATE OR REPLACE FUNCTION reject_account_lifecycle_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'account.delete' THEN
          RAISE EXCEPTION 'required account lifecycle audit unavailable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await database.execute("DROP TRIGGER IF EXISTS reject_account_lifecycle_audit ON audit_events");
    await database.execute("CREATE TRIGGER reject_account_lifecycle_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_account_lifecycle_audit()");
    try {
      await expect(current.auth.deleteOrganization({ accountId: current.accountId, userId: current.ownerId }))
        .rejects.toThrow(/required account lifecycle audit unavailable/i);
      await expect(accountRepository.findById(current.accountId)).resolves.toMatchObject({ id: current.accountId });
      await expect(machineAccessRepository.findCredential(credential.credential.id)).resolves.toMatchObject({ revokedAt: null });
    } finally {
      await database.execute("DROP TRIGGER IF EXISTS reject_account_lifecycle_audit ON audit_events");
      await database.execute("DROP FUNCTION IF EXISTS reject_account_lifecycle_audit()");
    }
  });
});
