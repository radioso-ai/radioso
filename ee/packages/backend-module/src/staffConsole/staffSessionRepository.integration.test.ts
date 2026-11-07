import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApplicationDatabasePort } from "../radiosoModuleTypes.js";
import { staffConsoleMigrator } from "./staffConsoleMigrator.js";
import { PostgresStaffUserRepository } from "./staffRepository.js";
import { PostgresStaffSessionRepository } from "./staffSessionRepository.js";

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

describeIfDatabase("staff session repository", () => {
  let pool: pg.Pool;
  let users: PostgresStaffUserRepository;
  let sessions: PostgresStaffSessionRepository;
  const schema = `ee_staff_session_test_${randomUUID().replace(/-/g, "")}`;

  const createStaff = (email: string) => users.create({
    email,
    name: "Owner",
    passwordHash: "unused",
    role: "owner",
  });
  const openSession = (staffId: string, tokenHash: string) => sessions.create({
    staffId,
    sessionTokenHash: tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
  });

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
    const database = new PgDatabase(pool);
    await staffConsoleMigrator.migrate(database);
    users = new PostgresStaffUserRepository(database);
    sessions = new PostgresStaffSessionRepository(database);
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

  it("reports when a session was last seen, and touching it moves that forward", async () => {
    const staff = await createStaff("seen@example.com");
    await openSession(staff.id, "seen-token");
    await pool.query(
      "UPDATE ee_staff_sessions SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE session_token_hash = $1",
      ["seen-token"],
    );

    const before = await sessions.findActiveByTokenHash("seen-token");
    await sessions.touch("seen-token");
    const after = await sessions.findActiveByTokenHash("seen-token");

    expect(Date.now() - before!.lastSeenAt.getTime()).toBeGreaterThan(59 * 60 * 1000);
    expect(Date.now() - after!.lastSeenAt.getTime()).toBeLessThan(60_000);
  });

  it("revokes every open session for one staff member and leaves others alone", async () => {
    const target = await createStaff("target@example.com");
    const other = await createStaff("other@example.com");
    await openSession(target.id, "target-a");
    await openSession(target.id, "target-b");
    await openSession(target.id, "target-already-revoked");
    await sessions.revoke("target-already-revoked");
    await openSession(other.id, "other-a");

    await expect(sessions.revokeAllForStaff(target.id)).resolves.toBe(2);

    await expect(sessions.findActiveByTokenHash("target-a")).resolves.toBeNull();
    await expect(sessions.findActiveByTokenHash("target-b")).resolves.toBeNull();
    await expect(sessions.findActiveByTokenHash("other-a")).resolves.not.toBeNull();
  });
});
