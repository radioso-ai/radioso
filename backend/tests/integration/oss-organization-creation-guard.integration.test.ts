import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import { OssOrganizationCreationGuard } from "../../src/modules/auth/composition.js";
import { PostgresOssOrganizationBootstrap } from "../../src/modules/auth/infra/postgresOssOrganizationBootstrap.js";
import { PostgresOrganizationProvisioner } from "../../src/modules/auth/infra/postgresOrganizationProvisioner.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { UserRepository } from "../../src/db/repositories/userRepository.js";
import { AccountMembershipRepository } from "../../src/db/repositories/accountMembershipRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { AccountAccessService, AccountInvitationService } from "../../src/modules/account/public.js";
import { WorkspaceService } from "../../src/modules/workspace/public.js";
import type { OrganizationCoreProvisioningRequest } from "../../src/shared/domain/organizationCreationGuard.js";
import { Database } from "../../src/shared/infra/database.js";
import {
  createAuditService,
  InMemoryAccountInvitationRepository,
  InMemoryFederatedIdentityRepository,
  InMemorySessionRepository,
  RecordingAccountInvitationNotifier,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";
import { resolveIntegrationDatabase } from "./support/integrationDatabase.js";

const { describeIntegration, integrationDatabaseUrl } = await resolveIntegrationDatabase();

const signupInput = (suffix: string): OrganizationCoreProvisioningRequest => ({
  intent: "new_user",
  organizationName: `OSS ${suffix}`,
  email: `owner-${suffix}@example.com`,
  passwordHash: "hash",
  emailVerifiedAt: null,
});

describeIntegration("OSS organization creation guard integration", () => {
  const schema = `oss_org_test_${randomUUID().replace(/-/g, "")}`;
  let database: Database;
  let schemaDatabaseUrl: string;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      for (const table of ["accounts", "users", "account_memberships", "workspaces"]) {
        await admin.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
    } finally {
      await admin.end();
    }
    const resolvedSchemaDatabaseUrl = new URL(integrationDatabaseUrl);
    resolvedSchemaDatabaseUrl.searchParams.set("options", `-c search_path=${schema}`);
    schemaDatabaseUrl = resolvedSchemaDatabaseUrl.toString();
    database = new Database(schemaDatabaseUrl, { poolMax: 1, connectionTimeoutMs: 2_000 });
  });

  afterAll(async () => {
    await database.close();
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });

  beforeEach(async () => {
    await database.query("DELETE FROM account_memberships");
    await database.query("DELETE FROM workspaces");
    await database.query("DELETE FROM accounts");
    await database.query("DELETE FROM users");
  });

  it("uses one pinned connection for the lock and core transaction when poolMax is one", async () => {
    const guard = new OssOrganizationCreationGuard(
      new PostgresOssOrganizationBootstrap(database, createAuditService()),
    );
    const reservation = await guard.reserve({ intent: "signup" });

    const result = await reservation.coreProvisioner!.provision(signupInput("single-connection"));
    await reservation.commit({ accountId: result.account.id });

    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM accounts"))
      .resolves.toEqual([{ count: "1" }]);
    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM account_memberships"))
      .resolves.toEqual([{ count: "1" }]);
    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM workspaces"))
      .resolves.toEqual([{ count: "1" }]);
  });

  it("allows only one complete organization across concurrent bootstrap attempts", async () => {
    const firstGuard = new OssOrganizationCreationGuard(
      new PostgresOssOrganizationBootstrap(database, createAuditService()),
    );
    const secondDatabase = new Database(schemaDatabaseUrl, { poolMax: 1, connectionTimeoutMs: 2_000 });
    const secondGuard = new OssOrganizationCreationGuard(
      new PostgresOssOrganizationBootstrap(secondDatabase, createAuditService()),
    );
    const first = await firstGuard.reserve({ intent: "signup" });
    const second = await secondGuard.reserve({ intent: "signup" });

    const settled = await Promise.allSettled([
      first.coreProvisioner!.provision(signupInput("concurrent-a")),
      second.coreProvisioner!.provision(signupInput("concurrent-b")),
    ]).finally(() => secondDatabase.close());

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ statusCode: 403, code: "forbidden" }) }),
    ]);
    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM accounts"))
      .resolves.toEqual([{ count: "1" }]);
    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users"))
      .resolves.toEqual([{ count: "1" }]);
    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM account_memberships"))
      .resolves.toEqual([{ count: "1" }]);
    await expect(database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM workspaces"))
      .resolves.toEqual([{ count: "1" }]);
  });

  it("allows only one complete organization through concurrent AuthService registrations", async () => {
    const secondDatabase = new Database(schemaDatabaseUrl, { poolMax: 1, connectionTimeoutMs: 2_000 });
    const firstService = createAuthService(database);
    const secondService = createAuthService(secondDatabase);

    const settled = await Promise.allSettled([
      firstService.register({ email: "full-concurrent-a@example.com", password: "verysecurepassword" }),
      secondService.register({ email: "full-concurrent-b@example.com", password: "verysecurepassword" }),
    ]).finally(() => secondDatabase.close());

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ statusCode: 403, code: "forbidden" }) }),
    ]);
    const counts = await Promise.all([
      database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM accounts"),
      database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users"),
      database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM account_memberships"),
      database.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM workspaces"),
    ]);
    expect(counts).toEqual([
      [{ count: "1" }],
      [{ count: "1" }],
      [{ count: "1" }],
      [{ count: "1" }],
    ]);
  });

  it("reports initialized state and reopens after the organization is deleted", async () => {
    const guard = new OssOrganizationCreationGuard(
      new PostgresOssOrganizationBootstrap(database, createAuditService()),
    );
    const reservation = await guard.reserve({ intent: "signup" });
    const result = await reservation.coreProvisioner!.provision(signupInput("reopen"));

    await expect(guard.isSignupAvailable()).resolves.toBe(false);
    await database.query("DELETE FROM account_memberships WHERE account_id = $1", [result.account.id]);
    await database.query("DELETE FROM workspaces WHERE account_id = $1", [result.account.id]);
    await database.query("DELETE FROM accounts WHERE id = $1", [result.account.id]);
    await database.query("DELETE FROM users WHERE id = $1", [result.userId]);
    await expect(guard.isSignupAvailable()).resolves.toBe(true);
  });

  it("always rejects signed-in additional organization creation", async () => {
    const guard = new OssOrganizationCreationGuard(
      new PostgresOssOrganizationBootstrap(database, createAuditService()),
    );

    await expect(guard.reserve({ intent: "additional", userId: randomUUID() })).rejects.toMatchObject({
      statusCode: 403,
      code: "forbidden",
    });
  });
});

const createAuthService = (database: Database): AuthService => {
  const auditService = createAuditService();
  const accountRepository = new AccountRepository(database.kysely);
  const userRepository = new UserRepository(database.kysely);
  const accountAccessService = new AccountAccessService(
    new AccountMembershipRepository(database.kysely),
    auditService,
  );
  const workspaceService = new WorkspaceService(new WorkspaceRepository(database.kysely), auditService);
  return new AuthService({
    env: createTestEnv(),
    auditService,
    accountRepository,
    userRepository,
    sessionRepository: new InMemorySessionRepository(),
    federatedIdentityRepository: new InMemoryFederatedIdentityRepository(),
    workspaceService,
    accountAccessService,
    accountInvitationService: new AccountInvitationService(
      new InMemoryAccountInvitationRepository(),
      userRepository,
      accountAccessService,
      auditService,
      new RecordingAccountInvitationNotifier(),
    ),
    organizationCreationGuard: new OssOrganizationCreationGuard(
      new PostgresOssOrganizationBootstrap(database, auditService),
    ),
    organizationProvisioner: new PostgresOrganizationProvisioner(database, auditService),
  });
};
