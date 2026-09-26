import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { EnterpriseUsageLimitService } from "./usageLimitService.js";
import { UsageLimitAccountNotFoundError, UsageLimitExceededError } from "./errors.js";
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
      monthlyConversationLimit?: number | null;
      repliesPerConversation?: number;
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
      monthlyConversationLimit: limits.monthlyConversationLimit ?? null,
      repliesPerConversation: limits.repliesPerConversation,
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

    const reservation = await service.reserveAnswer({ workspaceId, surface: "assistant", usage: "conversation_reply" });
    await reservation.commit();

    const rows = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ee_usage_limit_answer_counters WHERE account_id = $1`,
      [accountId],
    );
    expect(rows[0].count).toBe("0");
  });

  it("reads real document capacity from an assigned profile and leaves unassigned capacity unlimited", async () => {
    const assigned = await seedAccountWorkspace();
    await assignProfile(assigned.accountId, { storedDocumentLimit: 3, storedIndexedByteLimit: 100, monthlyIndexedByteLimit: 200 });
    await seedDocument(assigned.workspaceId, { contentSizeBytes: 40 });
    await seedDocument(assigned.workspaceId, { contentSizeBytes: 30 });
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.getDocumentCapacityUsage({ accountId: assigned.accountId, workspaceId: assigned.workspaceId }))
      .resolves.toMatchObject({ storedDocuments: { used: 2, limit: 3 }, storedIndexedBytes: { used: 70, limit: 100 }, monthlyIndexedBytes: { used: 0, limit: 200 } });

    const unlimited = await seedAccountWorkspace();
    await expect(service.getDocumentCapacityUsage({ accountId: unlimited.accountId, workspaceId: unlimited.workspaceId }))
      .resolves.toMatchObject({ storedDocuments: { used: 0, limit: null }, storedIndexedBytes: { used: 0, limit: null }, monthlyIndexedBytes: { used: 0, limit: null } });
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

    const reservation = await service.reserveAnswer({ accountId, workspaceId, surface: "assistant", usage: "conversation_reply" });

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "assistant", usage: "conversation_reply" }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await reservation.release();

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "assistant", usage: "conversation_reply" }))
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

  // ── Conversation metering: one unit for everything ──────────────────────

  it("charges a customer conversation once per block of replies", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1, repliesPerConversation: 3 });
    const service = new EnterpriseUsageLimitService(database);
    const conversationId = randomUUID();
    const reserve = () => service.reserveAnswer({ accountId, workspaceId, surface: "website_embed", usage: "conversation_reply", conversationId });

    // Replies 1-3 sit inside the one paid block; reply 4 opens a second block the plan cannot afford.
    await reserve();
    await reserve();
    await reserve();
    await expect(reserve()).rejects.toBeInstanceOf(UsageLimitExceededError);

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyConversations).toMatchObject({ used: 1, limit: 1, credits: 0 });
    expect(usage.monthlyConversations?.byKind.conversation).toBe(1);
  });

  it("charges a second conversation separately and releases it cleanly", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    const first = await service.reserveAnswer({ accountId, workspaceId, surface: "slack", usage: "conversation_reply", conversationId: randomUUID() });
    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "slack", usage: "conversation_reply", conversationId: randomUUID() }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await first.release();
    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "slack", usage: "conversation_reply", conversationId: randomUUID() }))
      .resolves.toBeDefined();
  });

  it("weights operator work by usage kind: two test runs are one, Ray is one, a Pulse report is ten", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 12 });
    const service = new EnterpriseUsageLimitService(database);

    for (let i = 0; i < 2; i += 1) {
      await service.reserveAnswer({ accountId, workspaceId, surface: "eval_replay", usage: "test_run" });
    }
    await service.reserveAnswer({ accountId, workspaceId, surface: "operator_copilot", usage: "copilot_turn" });
    await service.reserveAnswer({ accountId, workspaceId, surface: "audience_pulse", usage: "pulse_report" });

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyConversations?.used).toBe(12);
    expect(usage.monthlyConversations?.byKind).toEqual({ conversation: 0, copilot: 1, test_run: 1, pulse_report: 10 });
    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "workbench_replay", usage: "test_run" }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);
  });

  it("prices a test run by its usage kind, not by an unfamiliar surface label", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    // "test_execution" is not one of the legacy surface strings the old surfaceWeight switch
    // recognised; before the fix that default-billed a full customer conversation (10 tenths).
    await service.reserveAnswer({ accountId, workspaceId, surface: "test_execution", usage: "test_run" });

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyConversations?.byKind.test_run).toBe(0.5);
    expect(usage.monthlyConversations?.used).toBe(0.5);
  });

  it("never charges the widget greeting, even labeled with a customer-conversation surface", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 0 });
    const service = new EnterpriseUsageLimitService(database);

    // "website_embed" is the real sourceChannel the bootstrap greeting carries for attribution;
    // pricing must come from `usage: "greeting"` alone, not from that surface label.
    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "website_embed", usage: "greeting" })).resolves.toBeDefined();
    expect((await service.getAccountUsage(accountId)).monthlyConversations?.used).toBe(0);
  });

  it("spends the plan first, then prepaid credits, and refunds credits on release", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);
    await service.addCredits({ accountId, conversations: 1, reference: "plan-then-credit" });

    await service.reserveAnswer({ accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID() });
    const onCredit = await service.reserveAnswer({ accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID() });
    expect((await service.getAccountUsage(accountId)).monthlyConversations).toMatchObject({ used: 2, limit: 1, credits: 0 });

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID() }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await onCredit.release();
    expect((await service.getAccountUsage(accountId)).monthlyConversations).toMatchObject({ used: 1, credits: 1 });
  });

  it("keeps the legacy answer meter for profiles without a conversation limit", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyAnswerLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);

    await service.reserveAnswer({ accountId, workspaceId, surface: "website_embed", usage: "conversation_reply", conversationId: randomUUID() });
    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "website_embed", usage: "conversation_reply", conversationId: randomUUID() }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);
    expect((await service.getAccountUsage(accountId)).monthlyConversations).toBeNull();
  });

  it("seeds a profile per @radioso/plan-catalog plan with the catalog's own values", async () => {
    const service = new EnterpriseUsageLimitService(database);
    const profiles = await service.listProfiles();

    for (const plan of PLAN_CATALOG.plans) {
      const profile = profiles.find((candidate) => candidate.key === plan.id);
      expect(profile).toMatchObject({
        key: plan.id,
        displayName: plan.name,
        monthlyAnswerLimit: null,
        storedDocumentLimit: plan.documents,
        storedIndexedByteLimit: plan.storedBytes,
        monthlyIndexedByteLimit: plan.monthlyIndexedBytes,
        monthlyConversationLimit: plan.monthlyConversations,
        repliesPerConversation: PLAN_CATALOG.repliesPerConversation,
      });
    }
  });

  it("keeps a console edit to a seeded profile when the migrator runs again", async () => {
    const service = new EnterpriseUsageLimitService(database);
    const satellite = PLAN_CATALOG.plans.find((plan) => plan.id === "satellite")!;
    const edited = await service.upsertProfile({
      key: "satellite",
      displayName: satellite.name,
      monthlyAnswerLimit: null,
      storedDocumentLimit: satellite.documents,
      storedIndexedByteLimit: satellite.storedBytes,
      monthlyIndexedByteLimit: satellite.monthlyIndexedBytes,
      monthlyConversationLimit: 42,
      repliesPerConversation: PLAN_CATALOG.repliesPerConversation,
    });
    expect(edited.monthlyConversationLimit).toBe(42);

    await usageLimitMigrator.migrate(database);

    const profiles = await service.listProfiles();
    const reread = profiles.find((candidate) => candidate.key === "satellite");
    expect(reread?.monthlyConversationLimit).toBe(42);
  });

  it("does not report a monthly-answers cap when the profile meters conversations", async () => {
    const { accountId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyAnswerLimit: 500, monthlyConversationLimit: 10 });
    const service = new EnterpriseUsageLimitService(database);

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyAnswers.limit).toBeNull();
  });

  // ── Profile partial update ───────────────────────────────────────────────

  it("preserves conversation-metering fields when a later upsert sends only the legacy fields", async () => {
    const service = new EnterpriseUsageLimitService(database);
    const key = `it_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    await service.upsertProfile({
      key,
      displayName: "Metered",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit: 100,
      repliesPerConversation: 25,
    });

    const updated = await service.upsertProfile({
      key,
      displayName: "Metered v2",
      monthlyAnswerLimit: 10,
      storedDocumentLimit: 5,
    });

    expect(updated.displayName).toBe("Metered v2");
    expect(updated.monthlyAnswerLimit).toBe(10);
    expect(updated.storedDocumentLimit).toBe(5);
    expect(updated.monthlyConversationLimit).toBe(100);
    expect(updated.repliesPerConversation).toBe(25);
  });

  it("clears a conversation-metering field only when the caller sends an explicit null", async () => {
    const service = new EnterpriseUsageLimitService(database);
    const key = `it_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    await service.upsertProfile({
      key,
      displayName: "Metered",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit: 100,
      repliesPerConversation: 25,
    });

    const cleared = await service.upsertProfile({
      key,
      displayName: "Metered v3",
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit: null,
    });

    expect(cleared.monthlyConversationLimit).toBeNull();
    // repliesPerConversation was omitted, not cleared, so the earlier value survives.
    expect(cleared.repliesPerConversation).toBe(25);
  });

  // ── Credits ledger ───────────────────────────────────────────────────────

  it("addCredits is idempotent on (accountId, reference)", async () => {
    const { accountId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 10 });
    const service = new EnterpriseUsageLimitService(database);

    const first = await service.addCredits({ accountId, conversations: 5, reference: "stripe-evt-1" });
    expect(first).toEqual({ credits: 5, applied: true });

    const second = await service.addCredits({ accountId, conversations: 5, reference: "stripe-evt-1" });
    expect(second).toEqual({ credits: 5, applied: false });

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyConversations?.credits).toBe(5);
  });

  it("addCredits throws a typed not-found error for an unknown account", async () => {
    const service = new EnterpriseUsageLimitService(database);

    await expect(service.addCredits({ accountId: randomUUID(), conversations: 5, reference: "unknown-account" }))
      .rejects.toBeInstanceOf(UsageLimitAccountNotFoundError);
  });

  // ── Metering math: overdraw check and release-time refund ──────────────

  it("reviewer scenario: limit 100, buy 50 credits, spend all 150, buy 50 more so the next reply succeeds", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 100 });
    const service = new EnterpriseUsageLimitService(database);
    await service.addCredits({ accountId, conversations: 50, reference: "grant-1" });

    // A pulse_report call weighs ten conversations; fifteen calls spend all 150
    // conversations available (100 plan + 50 credits).
    for (let i = 0; i < 15; i += 1) {
      await service.reserveAnswer({ accountId, workspaceId, surface: "audience_pulse", usage: "pulse_report" });
    }

    const drained = await service.getAccountUsage(accountId);
    expect(drained.monthlyConversations).toMatchObject({ used: 150, limit: 100, credits: 0 });

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "audience_pulse", usage: "pulse_report" }))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    await service.addCredits({ accountId, conversations: 50, reference: "grant-2" });

    await expect(service.reserveAnswer({ accountId, workspaceId, surface: "audience_pulse", usage: "pulse_report" }))
      .resolves.toBeDefined();
  });

  it("reviewer scenario: limit 1 with 1 credit, releasing the plan-funded reservation still refunds a credit", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 1 });
    const service = new EnterpriseUsageLimitService(database);
    await service.addCredits({ accountId, conversations: 1, reference: "grant-b" });

    // Reserve A spends the plan unit (no credit touched); Reserve B spends the
    // one credit. Releasing A — not B — must still refund a credit, because the
    // refund is computed from current occupancy at release time, not from which
    // reservation happened to draw on credits when it was first made.
    const reserveA = await service.reserveAnswer({
      accountId,
      workspaceId,
      surface: "agent_api",
      usage: "conversation_reply",
      conversationId: randomUUID(),
    });
    await service.reserveAnswer({
      accountId,
      workspaceId,
      surface: "agent_api",
      usage: "conversation_reply",
      conversationId: randomUUID(),
    });

    await reserveA.release();

    const usage = await service.getAccountUsage(accountId);
    expect(usage.monthlyConversations).toMatchObject({ used: 1, credits: 1 });
  });
});
