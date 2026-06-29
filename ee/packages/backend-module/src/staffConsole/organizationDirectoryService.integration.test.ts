import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { usageLimitMigrator } from "../usageLimits/usageLimitMigrator.js";
import { OrganizationDirectoryService } from "./organizationDirectoryService.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

class PgDatabase implements UsageLimitDatabasePort {
  constructor(readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }
}

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

const createMinimalBaseSchema = async (database: UsageLimitDatabasePort): Promise<void> => {
  await database.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Account',
      email TEXT NOT NULL DEFAULT 'legacy-contact@example.com',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS account_memberships (
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, user_id)
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Workspace',
      public_route_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      content_size_bytes BIGINT,
      external_document_id TEXT,
      source_kind TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

describeIfDatabase("organization directory service", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_test_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({
      connectionString: integrationDatabaseUrl!,
      options: `-c search_path=${schema}`,
    });
    database = new PgDatabase(pool);
    await createMinimalBaseSchema(database);
    await usageLimitMigrator.migrate(database);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });

  it("paginates, searches, derives primary owners from memberships, and reads headline monthly answers only", async () => {
    const firstOwnerId = randomUUID();
    const secondOwnerId = randomUUID();
    const inactiveOwnerId = randomUUID();
    const alphaAccountId = randomUUID();
    const betaAccountId = randomUUID();
    const gammaAccountId = randomUUID();

    await database.query(
      `INSERT INTO users (id, email) VALUES
        ($1, 'primary-owner@example.com'),
        ($2, 'second-owner@example.com'),
        ($3, 'inactive-owner@example.com')`,
      [firstOwnerId, secondOwnerId, inactiveOwnerId],
    );
    await database.query(
      `INSERT INTO accounts (id, name, email, created_at) VALUES
        ($1, 'Alpha Research', 'legacy-alpha@example.com', '2026-01-02T00:00:00.000Z'),
        ($2, 'Beta Labs', 'legacy-beta@example.com', '2026-01-01T00:00:00.000Z'),
        ($3, 'Gamma No Owner', 'legacy-gamma@example.com', '2026-01-03T00:00:00.000Z')`,
      [alphaAccountId, betaAccountId, gammaAccountId],
    );
    await database.query(
      `INSERT INTO account_memberships (account_id, user_id, role, status, created_at) VALUES
        ($1, $3, 'owner', 'active', '2026-01-05T00:00:00.000Z'),
        ($1, $4, 'owner', 'active', '2026-01-06T00:00:00.000Z'),
        ($2, $5, 'owner', 'inactive', '2026-01-01T00:00:00.000Z'),
        ($2, $4, 'member', 'active', '2026-01-01T00:00:00.000Z')`,
      [alphaAccountId, betaAccountId, firstOwnerId, secondOwnerId, inactiveOwnerId],
    );
    await database.query(
      `INSERT INTO ee_usage_limit_profiles (
         key, display_name, monthly_answer_limit, stored_document_limit,
         stored_indexed_byte_limit, monthly_indexed_byte_limit
       ) VALUES ('starter', 'Starter', 10, 20, NULL, NULL)`,
    );
    await database.query(
      `INSERT INTO ee_usage_limit_account_assignments (account_id, profile_key)
       VALUES ($1, 'starter')`,
      [alphaAccountId],
    );
    await database.query(
      `INSERT INTO ee_usage_limit_answer_counters (account_id, period_start, used_count)
       VALUES ($1, '2026-06-01', 7)`,
      [alphaAccountId],
    );

    const service = new OrganizationDirectoryService(database, {
      now: () => new Date("2026-06-29T12:00:00.000Z"),
    });

    const firstPage = await service.listOrganizations({ limit: 2 });

    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.pageInfo).toEqual({ limit: 2, offset: 0, nextOffset: 2, hasMore: true, total: 3 });
    expect(firstPage.rows[0]).toMatchObject({
      accountId: betaAccountId,
      name: "Beta Labs",
      ownerEmail: null,
      ownerCount: 0,
      profileKey: null,
      profileDisplayName: null,
      monthlyAnswers: { used: 0, limit: null },
    });
    expect(firstPage.rows[1]).toMatchObject({
      accountId: alphaAccountId,
      name: "Alpha Research",
      ownerEmail: "primary-owner@example.com",
      ownerCount: 2,
      profileKey: "starter",
      profileDisplayName: "Starter",
      monthlyAnswers: { used: 7, limit: 10 },
    });
    expect(firstPage.rows.map((row) => row.ownerEmail)).not.toContain("legacy-alpha@example.com");

    const searched = await service.listOrganizations({ limit: 10, search: "second-owner@example.com" });
    expect(searched.rows.map((row) => row.accountId)).toEqual([alphaAccountId]);
  });
});
