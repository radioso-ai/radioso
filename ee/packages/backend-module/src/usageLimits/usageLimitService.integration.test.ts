import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EnterpriseUsageLimitService } from "./usageLimitService.js";
import { UsageLimitExceededError } from "./errors.js";
import { usageLimitMigrator } from "./usageLimitMigrator.js";
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

// Mirrors the OSS migration pattern: the SQL-string mock unit suite was replaced
// by this real-Postgres characterization once the service moved onto Kysely. The
// service builds its own Kysely from `database.pool`, so behavior can only be
// asserted against a live database.
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

describeIfDatabase("EE usage limit service integration", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  // Isolate this suite in its own randomly-named Postgres schema so its minimal
  // base tables (users/accounts/workspaces/documents/messages + ee_*) never collide
  // with the full OSS schema living in `public` on the shared ci:local test DB.
  const schema = `ee_test_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    // Pin the dedicated schema (NOT public) on every connection in the test pool so
    // unqualified table names resolve to this suite's isolated tables.
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

  // Each test provisions its own account + workspace and a private profile key so
  // runs never collide across the shared database.
  const seedAccountWorkspace = async (): Promise<{ accountId: string; workspaceId: string }> => {
    const accountId = randomUUID();
    const workspaceId = randomUUID();
    await database.query(
      `INSERT INTO accounts (id, name, email, password_hash) VALUES ($1, $2, $3, 'hash') ON CONFLICT (id) DO NOTHING`,
      [accountId, "Usage Integration Account", `usage-${accountId}@example.com`],
    );
    // `public_route_key` is NOT NULL (and UNIQUE) in the full OSS schema; provide a unique
    // value so this test works against both a clean minimal DB and the shared OSS test DB.
    await database.query(
      `INSERT INTO workspaces (id, account_id, name, public_route_key) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [workspaceId, accountId, "Usage Integration Workspace", `usage-route-${workspaceId}`],
    );
    return { accountId, workspaceId };
  };

  const assignProfile = async (
    accountId: string,
    limits: {
      monthlyAnswerLimit?: number | null;
      storedDocumentLimit?: number | null;
      storedIndexedByteLimit?: number | null;
      monthlyIndexedByteLimit?: number | null;
    },
  ): Promise<void> => {
    const service = new EnterpriseUsageLimitService(database);
    const key = `it_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await service.upsertProfile({
      key,
      displayName: "Integration Profile",
      monthlyAnswerLimit: limits.monthlyAnswerLimit ?? null,
      storedDocumentLimit: limits.storedDocumentLimit ?? null,
      storedIndexedByteLimit: limits.storedIndexedByteLimit ?? null,
      monthlyIndexedByteLimit: limits.monthlyIndexedByteLimit ?? null,
    });
    await service.assignProfile(accountId, key);
  };

  const seedDocument = async (
    workspaceId: string,
    input: { contentSizeBytes?: number | null; externalDocumentId?: string | null; sourceKind?: string },
  ): Promise<void> => {
    await database.query(
      `INSERT INTO documents (id, workspace_id, content_size_bytes, external_document_id, source_kind)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), workspaceId, input.contentSizeBytes ?? null, input.externalDocumentId ?? null, input.sourceKind ?? "uploaded_file"],
    );
  };

  it("leaves unassigned accounts unlimited", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveAnswer({ workspaceId, surface: "assistant" });
    await reservation.commit();

    const rows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ee_usage_limit_answer_counters WHERE account_id = $1`,
      [accountId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("reports persisted assistant messages for uncapped account usage", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await database.query(
      `INSERT INTO messages (id, workspace_id, role, created_at) VALUES
        ($1, $5, 'assistant', '2026-05-05T12:00:00.000Z'),
        ($2, $5, 'assistant', '2026-05-06T12:00:00.000Z'),
        ($3, $5, 'assistant', '2026-04-30T12:00:00.000Z'),
        ($4, $5, 'user', '2026-05-07T12:00:00.000Z')`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), workspaceId],
    );
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage(accountId, "2026-05-01");

    expect(usage.profile).toBeNull();
    expect(usage.monthlyAnswers.used).toBe(2);
    expect(usage.monthlyAnswers.limit).toBeNull();
  });

  it("reserves monthly answer usage and releases failed attempts", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyAnswerLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveAnswer({ accountId, workspaceId, surface: "assistant" });

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "assistant" }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await reservation.release();

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "assistant" }))
      .resolves.toBeDefined();
  });

  it("blocks net-new documents while allowing existing external document upserts", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { storedDocumentLimit: 1 });
    await seedDocument(workspaceId, {
      externalDocumentId: "existing-external",
      sourceKind: "inline_text",
    });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.reserveDocument({ accountId, workspaceId, sourceKind: "inline_text" }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await expect(service.reserveDocument({
      accountId,
      workspaceId,
      sourceKind: "inline_text",
      externalDocumentId: "existing-external",
    })).resolves.toBeDefined();
  });

  it("treats indexed storage as unlimited when the profile has no byte cap", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { storedIndexedByteLimit: null });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveIndexedStorage({
      accountId,
      workspaceId,
      contentSizeBytes: 10_000_000,
    });
    await reservation.commit();

    const rows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ee_usage_limit_storage_reservations WHERE account_id = $1`,
      [accountId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("rejects indexed storage reservations that would exceed the configured byte cap", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { storedIndexedByteLimit: 1_024 });
    await seedDocument(workspaceId, { sourceKind: "inline_text", contentSizeBytes: 1_000 });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.reserveIndexedStorage({ accountId, workspaceId, contentSizeBytes: 50 }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);
  });

  it("counts persisted bytes plus reservations, then inserts a TTL reservation", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { storedIndexedByteLimit: 10_000 });
    const service = new EnterpriseUsageLimitService(database);

    const first = await service.reserveIndexedStorage({ accountId, workspaceId, contentSizeBytes: 6_000 });

    const reserved = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ee_usage_limit_storage_reservations
       WHERE account_id = $1 AND expires_at > NOW()`,
      [accountId],
    );
    expect(reserved[0].count).toBe("1");

    await expect(service.reserveIndexedStorage({ accountId, workspaceId, contentSizeBytes: 5_000 }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await first.release();
    const afterRelease = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ee_usage_limit_storage_reservations WHERE account_id = $1`,
      [accountId],
    );
    expect(afterRelease[0].count).toBe("0");

    const next = await service.reserveIndexedStorage({ accountId, workspaceId, contentSizeBytes: 5_000 });
    await next.commit();
  });

  it("exposes stored indexed bytes in account usage with byte limit from the profile", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { storedIndexedByteLimit: 1_000_000 });
    await seedDocument(workspaceId, { sourceKind: "inline_text", contentSizeBytes: 4_096 });
    await seedDocument(workspaceId, { sourceKind: "uploaded_file", contentSizeBytes: 8_192 });
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage(accountId, "2026-05-01");

    expect(usage.storedIndexedBytes).toEqual({ used: 4_096 + 8_192, limit: 1_000_000 });
  });

  it("returns a null indexed byte limit when no profile is assigned", async () => {
    const { accountId } = await seedAccountWorkspace();
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage(accountId, "2026-05-01");

    expect(usage.storedIndexedBytes).toEqual({ used: 0, limit: null });
    expect(usage.monthlyIndexedBytes).toEqual({
      periodStart: "2026-05-01",
      resetAt: expect.any(String),
      used: 0,
      limit: null,
    });
  });

  it("reserves monthly indexed content and rejects once the period budget is exhausted", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyIndexedByteLimit: 10_000 });
    const service = new EnterpriseUsageLimitService(database);

    const first = await service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 6_000 });
    await first.commit();

    await expect(service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 5_000 }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    const second = await service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 4_000 });
    await second.commit();
  });

  it("meters monthly indexed content even when the account has no byte limit", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 5_000 });
    await reservation.commit();

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyIndexedBytes.used).toBe(5_000);
    expect(usage.monthlyIndexedBytes.limit).toBeNull();
  });

  it("releases the metered bytes on an unlimited account when the reservation is released", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 2_500 });
    await reservation.release();

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyIndexedBytes.used).toBe(0);
  });

  it("releases monthly indexed content reservations on failure", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyIndexedByteLimit: 1_000 });
    const service = new EnterpriseUsageLimitService(database);

    const reservation = await service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 800 });

    await expect(service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 300 }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await reservation.release();

    await expect(service.reserveMonthlyIndexedContent({ accountId, workspaceId, contentSizeBytes: 300 }))
      .resolves.toBeDefined();
  });

  it("round-trips profile bigint byte limits through upsert and read", async () => {
    const { accountId } = await seedAccountWorkspace();
    const service = new EnterpriseUsageLimitService(database);
    const key = `it_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const upserted = await service.upsertProfile({
      key,
      displayName: "Bigint Profile",
      monthlyAnswerLimit: 100,
      storedDocumentLimit: 50,
      storedIndexedByteLimit: 5_000_000,
      monthlyIndexedByteLimit: 2_000_000,
    });
    expect(upserted).toMatchObject({
      storedIndexedByteLimit: 5_000_000,
      monthlyIndexedByteLimit: 2_000_000,
    });

    await service.assignProfile(accountId, key);
    const usage = await service.getAccountUsage(accountId);
    expect(usage.profile).toMatchObject({
      storedIndexedByteLimit: 5_000_000,
      monthlyIndexedByteLimit: 2_000_000,
    });
  });
});
