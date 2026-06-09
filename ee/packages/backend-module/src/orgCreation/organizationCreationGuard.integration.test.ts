import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EnterpriseOrganizationCreationGuard,
  OrganizationCreationLimitExceededError,
} from "./organizationCreationGuard.js";
import { usageLimitMigrator } from "../usageLimits/usageLimitMigrator.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";

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
      password_hash TEXT NOT NULL,
      email_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Integration Account',
      email TEXT NOT NULL DEFAULT 'integration@example.com',
      password_hash TEXT NOT NULL DEFAULT 'hash',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id UUID PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'Integration Workspace',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

describeIfDatabase("EE organization creation guard integration", () => {
  let pool: pg.Pool;
  let database: PgDatabase;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    database = new PgDatabase(pool);
    await createMinimalBaseSchema(database);
    await usageLimitMigrator.migrate(database);
  });

  afterAll(async () => {
    await pool.end();
  });

  const seedUser = async (): Promise<string> => {
    const userId = randomUUID();
    await database.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at)
       VALUES ($1, $2, 'hash', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `org-cap-${userId}@example.com`],
    );
    return userId;
  };

  it("creates organization creation counter and override tables", async () => {
    const rows = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('ee_org_creation_counters', 'ee_org_creation_overrides')
       ORDER BY table_name`,
    );

    expect(rows.map((row) => row.table_name)).toEqual([
      "ee_org_creation_counters",
      "ee_org_creation_overrides",
    ]);
  });

  it("allows only one concurrent reservation at the limit boundary", async () => {
    const userId = await seedUser();
    const guard = new EnterpriseOrganizationCreationGuard(database, {
      defaultLimit: 1,
      now: () => new Date("2026-06-09T12:00:00.000Z"),
    });

    const results = await Promise.allSettled([
      guard.reserve({ userId }),
      guard.reserve({ userId }),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: expect.any(OrganizationCreationLimitExceededError),
    });

    const rows = await database.query<{ used_count: number }>(
      `SELECT used_count
       FROM ee_org_creation_counters
       WHERE user_id = $1 AND period_start = '2026-06-01'::date`,
      [userId],
    );
    expect(rows[0].used_count).toBe(1);
  });
});
