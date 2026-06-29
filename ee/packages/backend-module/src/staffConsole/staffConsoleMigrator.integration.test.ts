import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApplicationDatabasePort } from "../radiosoModuleTypes.js";
import { staffConsoleMigrator } from "./staffConsoleMigrator.js";

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

class PgDatabase implements ApplicationDatabasePort {
  constructor(readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }
}

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("staff console migrator", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_staff_test_${randomUUID().replace(/-/g, "")}`;

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
    await staffConsoleMigrator.migrate(database);
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

  it("creates staff users and sessions with global identities and required indexes", async () => {
    const columns = await database.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name IN ('ee_staff_users', 'ee_staff_sessions')
    `);

    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: "ee_staff_users", column_name: "id" }),
      expect.objectContaining({ table_name: "ee_staff_users", column_name: "email" }),
      expect.objectContaining({ table_name: "ee_staff_users", column_name: "password_hash" }),
      expect.objectContaining({ table_name: "ee_staff_users", column_name: "role" }),
      expect.objectContaining({ table_name: "ee_staff_sessions", column_name: "session_token_hash" }),
      expect.objectContaining({ table_name: "ee_staff_sessions", column_name: "staff_id" }),
    ]));
    expect(columns).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: "ee_staff_users", column_name: "workspace_id" }),
      expect.objectContaining({ table_name: "ee_staff_users", column_name: "account_id" }),
    ]));

    const indexes = await database.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename IN ('ee_staff_users', 'ee_staff_sessions')
    `);

    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ indexname: "idx_ee_staff_sessions_staff_id" }),
      expect.objectContaining({ indexname: "idx_ee_staff_sessions_token_hash_unique" }),
      expect.objectContaining({ indexname: "idx_ee_staff_users_email_lower_unique" }),
    ]));
  });
});
