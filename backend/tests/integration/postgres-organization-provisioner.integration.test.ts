import { randomUUID } from "node:crypto";

import { afterAll, expect, it } from "vitest";

import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { UserFederatedIdentityRepository } from "../../src/db/repositories/userFederatedIdentityRepository.js";
import { UserRepository } from "../../src/db/repositories/userRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService, AccountInvitationService } from "../../src/modules/account/public.js";
import { PostgresOrganizationProvisioner } from "../../src/modules/auth/infra/postgresOrganizationProvisioner.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { WorkspaceService } from "../../src/modules/workspace/public.js";
import { Database } from "../../src/shared/infra/database.js";
import {
  createAuditService,
  InMemoryAccountInvitationRepository,
  InMemorySessionRepository,
  RecordingAccountInvitationNotifier,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

describeIntegration("PostgresOrganizationProvisioner", () => {
  const database = new Database(integrationDatabaseUrl);
  const provisioner = new PostgresOrganizationProvisioner(database, createAuditService());
  const accountIds = new Set<string>();
  const userIds = new Set<string>();

  afterAll(async () => {
    for (const accountId of accountIds) {
      await database.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
    }
    for (const userId of userIds) {
      await database.query("DELETE FROM users WHERE id = $1", [userId]).catch(() => undefined);
    }
    await database.close().catch(() => undefined);
  });

  it("commits a new organization, user, owner membership, and default workspace together", async () => {
    const email = `atomic-success-${randomUUID()}@example.com`;

    const result = await provisioner.provision({
      intent: "new_user",
      organizationName: "Atomic Success",
      email,
      passwordHash: "hash",
      emailVerifiedAt: null,
    });
    accountIds.add(result.account.id);
    userIds.add(result.userId);

    const [accounts, users, memberships, workspaces] = await Promise.all([
      database.query<{ id: string }>("SELECT id FROM accounts WHERE id = $1", [result.account.id]),
      database.query<{ id: string }>("SELECT id FROM users WHERE id = $1", [result.userId]),
      database.query<{ role: string }>(
        "SELECT role FROM account_memberships WHERE account_id = $1 AND user_id = $2",
        [result.account.id, result.userId],
      ),
      database.query<{ name: string }>("SELECT name FROM workspaces WHERE account_id = $1", [result.account.id]),
    ]);

    expect(accounts).toHaveLength(1);
    expect(users).toHaveLength(1);
    expect(memberships).toEqual([{ role: "owner" }]);
    expect(workspaces).toEqual([{ name: "Default" }]);
  });

  it("rejects a duplicate new user without leaving organization artifacts", async () => {
    const email = `atomic-rollback-${randomUUID()}@example.com`;
    const existingUserId = randomUUID();
    userIds.add(existingUserId);
    await new UserRepository(database.kysely).create({
      id: existingUserId,
      email,
      passwordHash: "existing-hash",
    });

    await expect(provisioner.provision({
      intent: "new_user",
      organizationName: "Must Roll Back",
      email,
      passwordHash: "new-hash",
      emailVerifiedAt: null,
    })).rejects.toThrow();

    await expect(database.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [email]))
      .resolves.toEqual([]);
    await expect(database.query<{ id: string }>("SELECT id FROM account_memberships WHERE user_id = $1", [existingUserId]))
      .resolves.toEqual([]);
    await expect(database.query<{ id: string }>("SELECT id FROM workspaces WHERE account_id IN (SELECT id FROM accounts WHERE email = $1)", [email]))
      .resolves.toEqual([]);
  });

  it("rolls back the account when owner membership fails after the account insert", async () => {
    const missingUserId = randomUUID();
    const email = `atomic-missing-owner-${randomUUID()}@example.com`;

    await expect(provisioner.provision({
      intent: "existing_user",
      userId: missingUserId,
      organizationName: "Must Roll Back After Insert",
      email,
      passwordHash: "hash",
    })).rejects.toThrow();

    await expect(database.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [email]))
      .resolves.toEqual([]);
    await expect(database.query<{ id: string }>("SELECT id FROM account_memberships WHERE user_id = $1", [missingUserId]))
      .resolves.toEqual([]);
    await expect(database.query<{ id: string }>("SELECT id FROM workspaces WHERE account_id IN (SELECT id FROM accounts WHERE email = $1)", [email]))
      .resolves.toEqual([]);
  });

  it("atomically attaches an existing user to an additional organization", async () => {
    const userId = randomUUID();
    const email = `atomic-existing-${randomUUID()}@example.com`;
    userIds.add(userId);
    await new UserRepository(database.kysely).create({ id: userId, email, passwordHash: "hash" });

    const result = await provisioner.provision({
      intent: "existing_user",
      userId,
      organizationName: "Additional Atomic",
      email,
      passwordHash: "hash",
    });
    accountIds.add(result.account.id);

    const [memberships, workspaces, users] = await Promise.all([
      database.query<{ role: string }>(
        "SELECT role FROM account_memberships WHERE account_id = $1 AND user_id = $2",
        [result.account.id, userId],
      ),
      database.query<{ name: string }>("SELECT name FROM workspaces WHERE account_id = $1", [result.account.id]),
      database.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]),
    ]);

    expect(result.userId).toBe(userId);
    expect(memberships).toEqual([{ role: "owner" }]);
    expect(workspaces).toEqual([{ name: "Default" }]);
    expect(users).toEqual([{ id: userId }]);
  });

  it("compensates the complete graph when an orderly post-core hook fails", async () => {
    const email = `post-core-compensation-${randomUUID()}@example.com`;
    let coreAccountId: string | null = null;
    const auditService = createAuditService();
    const accountRepository = new AccountRepository(database.kysely);
    const userRepository = new UserRepository(database.kysely);
    const accountAccessService = new AccountAccessService(
      new AccountMembershipRepository(database.kysely),
      auditService,
    );
    const workspaceService = new WorkspaceService(new WorkspaceRepository(database.kysely), auditService);
    const authService = new AuthService({
      env: createTestEnv(),
      auditService,
      accountRepository,
      userRepository,
      sessionRepository: new InMemorySessionRepository(),
      federatedIdentityRepository: new UserFederatedIdentityRepository(database.kysely),
      workspaceService,
      accountAccessService,
      accountInvitationService: new AccountInvitationService(
        new InMemoryAccountInvitationRepository(),
        userRepository,
        accountAccessService,
        auditService,
        new RecordingAccountInvitationNotifier(),
      ),
      organizationProvisioner: provisioner,
      onAccountCreated: async ({ accountId }) => {
        coreAccountId = accountId;
        throw new Error("post-core hook failed");
      },
    });

    await expect(authService.register({ email, password: "verysecurepassword" }))
      .rejects.toThrow("post-core hook failed");
    expect(coreAccountId).not.toBeNull();

    const [accounts, users, memberships, workspaces] = await Promise.all([
      database.query<{ id: string }>("SELECT id FROM accounts WHERE id = $1", [coreAccountId]),
      database.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]),
      database.query<{ id: string }>("SELECT id FROM account_memberships WHERE account_id = $1", [coreAccountId]),
      database.query<{ id: string }>("SELECT id FROM workspaces WHERE account_id = $1", [coreAccountId]),
    ]);
    expect({ accounts, users, memberships, workspaces }).toEqual({
      accounts: [],
      users: [],
      memberships: [],
      workspaces: [],
    });
  });
});
