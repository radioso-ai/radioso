import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import {
  EnterpriseUsageLimitService,
  TENTHS_PER_CONVERSATION,
  type UsageKind,
  type UsageLimitProfile,
} from "./usageLimitService.js";
import { UsageLimitAccountNotFoundError, UsageLimitExceededError } from "./errors.js";
import { usageLimitMigrator } from "./usageLimitMigrator.js";
import type { UsageLimitDatabasePort, UsageLimitReservation } from "../radiosoModuleTypes.js";

const tenths = (conversations: number): number => conversations * TENTHS_PER_CONVERSATION;

// `reserveTenths` is private: the public surface always resolves its own period from the
// system clock, so the only way to exercise two period starts in the same test -- the
// concurrency race across a UTC month rollover, and "next period" carried-debt scenarios --
// is to call it directly with a literal period string, bypassing TypeScript's privacy (a
// compile-time-only restriction) for this one white-box case.
type ReserveTenthsAccess = {
  reserveTenths(
    accountId: string,
    profile: UsageLimitProfile,
    periodStart: string,
    kind: UsageKind,
    reservedTenths: number,
    limitTenths: number,
  ): Promise<UsageLimitReservation>;
};

const reserveTenthsDirect = (
  service: EnterpriseUsageLimitService,
  accountId: string,
  profile: UsageLimitProfile,
  periodStart: string,
  kind: UsageKind,
  reservedTenths: number,
  limitTenths: number,
): Promise<UsageLimitReservation> =>
  (service as unknown as ReserveTenthsAccess).reserveTenths(accountId, profile, periodStart, kind, reservedTenths, limitTenths);

const fakeConversationProfile = (limitTenths: number): UsageLimitProfile => ({
  key: `fake_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
  displayName: "Fake Profile",
  monthlyAnswerLimit: null,
  storedDocumentLimit: null,
  storedIndexedByteLimit: null,
  monthlyIndexedByteLimit: null,
  monthlyConversationLimit: limitTenths / TENTHS_PER_CONVERSATION,
  repliesPerConversation: 10,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

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

  it("weights operator work by usage kind: two test runs are one, two Ray turns are one (CFO-approved 2026-09-15), a Pulse report is ten", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 12 });
    const service = new EnterpriseUsageLimitService(database);

    for (let i = 0; i < 2; i += 1) {
      await service.reserveAnswer({ accountId, workspaceId, surface: "eval_replay", usage: "test_run" });
    }
    // A Ray turn counts as half a conversation, the same as a test run, so two turns make one.
    for (let i = 0; i < 2; i += 1) {
      await service.reserveAnswer({ accountId, workspaceId, surface: "operator_copilot", usage: "copilot_turn" });
    }
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

  // ── Grace allowance ──────────────────────────────────────────────────────

  it("drops the legacy nonnegative CHECK on balance_tenths on an account upgrading from before grace existed", async () => {
    // `beforeAll` already ran the migrator once against a schema that never had this CHECK
    // (CREATE TABLE IF NOT EXISTS skips it), so asserting the constraint's absence there alone
    // would pass even if the migrator's `DROP CONSTRAINT` were deleted. Recreate the table as a
    // pre-grace install actually had it -- with the CHECK inline -- so this test only passes if
    // the migrator really drops it.
    await database.query(`DROP TABLE IF EXISTS ee_usage_limit_credits`);
    await database.query(`
      CREATE TABLE ee_usage_limit_credits (
        account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        balance_tenths INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ee_usage_limit_credits_balance_tenths_check CHECK (balance_tenths >= 0)
      )
    `);

    const { accountId } = await seedAccountWorkspace();
    await database.query(
      `INSERT INTO ee_usage_limit_credits (account_id, balance_tenths) VALUES ($1, 0)`,
      [accountId],
    );

    // Two boots in a row, as a real deploy runs the migrator on every start: the idempotent
    // `DROP CONSTRAINT IF EXISTS` must survive a second run finding nothing left to drop.
    await usageLimitMigrator.migrate(database);
    await usageLimitMigrator.migrate(database);

    const rows = await database.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'ee_usage_limit_credits'::regclass`,
    );
    expect(rows.map((row) => row.conname)).not.toContain("ee_usage_limit_credits_balance_tenths_check");

    // The CHECK this account started under would have rejected this write outright.
    const written = await database.query<{ balance_tenths: number }>(
      `UPDATE ee_usage_limit_credits SET balance_tenths = -10 WHERE account_id = $1 RETURNING balance_tenths`,
      [accountId],
    );
    expect(written[0].balance_tenths).toBe(-10);
  });

  it("lets a customer conversation borrow down to the grace floor, then refuses and stays at the floor", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    // limit 10 conversations -> grace floor(10 * 0.1) = 1 conversation (10 tenths).
    await assignProfile(accountId, { monthlyConversationLimit: 10 });
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    for (let i = 0; i < 10; i += 1) {
      await reserveConversation();
    }
    // The 11th conversation borrows the one conversation of grace the plan allows.
    await expect(reserveConversation()).resolves.toBeDefined();

    const borrowed = await service.getAccountUsage(accountId);
    expect(borrowed.monthlyConversations).toMatchObject({ used: 11, credits: 0 });

    // The 12th would borrow past the floor and is refused; the balance stays at the floor.
    await expect(reserveConversation()).rejects.toBeInstanceOf(UsageLimitExceededError);

    const stillAtFloor = await service.getAccountUsage(accountId);
    expect(stillAtFloor.monthlyConversations).toMatchObject({
      used: 11,
      capacity: 11,
      grace: { limit: 1, borrowed: 1 },
      level: "grace_exhausted",
    });
  });

  it("stops an internal kind at the allowance plus positive credits, never borrowing and never blocked earlier by carried debt", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    // limit 20 conversations -> grace floor(20 * 0.1) = 2 conversations (20 tenths).
    await assignProfile(accountId, { monthlyConversationLimit: 20 });
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });
    const reserveRayTurn = () => service.reserveAnswer({ accountId, workspaceId, surface: "operator_copilot", usage: "copilot_turn" });

    // An internal kind reserves fine while usage sits under the allowance, even
    // though nothing has been charged against this account yet.
    const earlyRayTurn = await reserveRayTurn();
    await earlyRayTurn.release();

    // Fill the plan allowance, then borrow the full grace (2 conversations) into debt.
    for (let i = 0; i < 22; i += 1) {
      await reserveConversation();
    }
    const indebted = await service.getAccountUsage(accountId);
    expect(indebted.monthlyConversations).toMatchObject({ used: 22, credits: 0, grace: { limit: 2, borrowed: 2 } });

    // An internal kind never borrows: once usage is past the allowance, it is
    // refused immediately, not pushed further by the carried debt.
    await expect(reserveRayTurn()).rejects.toBeInstanceOf(UsageLimitExceededError);

    // A grant that only partly repays the debt still leaves the internal kind refused:
    // debt, not positive credit, is what remains.
    const partial = await service.addCredits({ accountId, conversations: 1, reference: "partial-repay" });
    expect(partial.credits).toBe(0);
    await expect(reserveRayTurn()).rejects.toBeInstanceOf(UsageLimitExceededError);

    // Once the grant pays the debt down into a positive balance, the internal kind can
    // spend that positive balance exactly like ordinary prepaid credit.
    const topUp = await service.addCredits({ accountId, conversations: 2, reference: "full-repay" });
    expect(topUp.credits).toBe(1);
    await expect(reserveRayTurn()).resolves.toBeDefined();
  });

  it("carries debt across periods: the next period's allowance is full, but the grace stays reduced until a grant repays it", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    // limit 10 conversations -> grace floor(10 * 0.1) = 1 conversation (10 tenths).
    await assignProfile(accountId, { monthlyConversationLimit: 10 });
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    for (let i = 0; i < 11; i += 1) {
      await reserveConversation();
    }
    const currentPeriod = await service.getAccountUsage(accountId);
    expect(currentPeriod.monthlyConversations).toMatchObject({ used: 11, grace: { limit: 1, borrowed: 1 } });

    // `ee_usage_limit_credits.balance_tenths` carries no period column: a different
    // period reads a fresh (empty) unit counter, so the allowance is back to full,
    // while the account-wide balance -- and therefore the grace debt -- is unchanged.
    const nextPeriod = await service.getAccountUsage(accountId, "2031-01-01");
    expect(nextPeriod.monthlyConversations).toMatchObject({
      used: 0,
      limit: 10,
      credits: 0,
      capacity: 10,
      grace: { limit: 1, borrowed: 1 },
      level: "ok",
    });
  });

  it("releases a borrowed conversation back to the exact pre-reservation balance", async () => {
    const { accountId, workspaceId } = await seedAccountWorkspace();
    await assignProfile(accountId, { monthlyConversationLimit: 10 });
    const service = new EnterpriseUsageLimitService(database);
    const reserveConversation = () => service.reserveAnswer({
      accountId, workspaceId, surface: "agent_api", usage: "conversation_reply", conversationId: randomUUID(),
    });

    for (let i = 0; i < 10; i += 1) {
      await reserveConversation();
    }
    const borrowing = await reserveConversation();
    const borrowed = await service.getAccountUsage(accountId);
    expect(borrowed.monthlyConversations).toMatchObject({ used: 11, credits: 0, grace: { borrowed: 1 } });

    await borrowing.release();

    const released = await service.getAccountUsage(accountId);
    expect(released.monthlyConversations).toMatchObject({ used: 10, credits: 0, grace: { borrowed: 0 } });
  });

  it("gives a next-period reservation the full allowance plus only the carried debt's reduced grace, when debt is within grace", async () => {
    const { accountId } = await seedAccountWorkspace();
    // limit 20 conversations -> grace floor(20 * 0.1) = 2 conversations (20 tenths).
    const limitTenths = tenths(20);
    const profile = fakeConversationProfile(limitTenths);
    const service = new EnterpriseUsageLimitService(database);

    // Carry 1 conversation (10 tenths) of debt into the next period -- within the 2-conversation grace.
    await database.query(
      `INSERT INTO ee_usage_limit_credits (account_id, balance_tenths) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET balance_tenths = $2`,
      [accountId, -tenths(1)],
    );

    const nextPeriod = "2031-03-01";
    // The fresh period's own allowance is untouched by the carried debt: seed usage at the limit.
    await database.query(
      `INSERT INTO ee_usage_limit_unit_counters (account_id, period_start, used_tenths) VALUES ($1, $2::date, $3)`,
      [accountId, nextPeriod, limitTenths],
    );

    // The reduced grace (2 - 1 = 1 conversation) still admits one more conversation...
    await reserveTenthsDirect(service, accountId, profile, nextPeriod, "conversation", tenths(1), limitTenths);

    // ...but not a second: the carried debt already ate the rest of the grace.
    await expect(reserveTenthsDirect(service, accountId, profile, nextPeriod, "conversation", tenths(1), limitTenths))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    const credits = await database.query<{ balance_tenths: number }>(
      `SELECT balance_tenths FROM ee_usage_limit_credits WHERE account_id = $1`,
      [accountId],
    );
    // -1 (carried) - 1 (newly borrowed) = -2 conversations: the account's full, period-independent grace floor.
    expect(credits[0].balance_tenths).toBe(-tenths(2));
  });

  it("gives a next-period reservation the full allowance but zero borrowing room once a downgrade leaves carried debt bigger than the new grace", async () => {
    const { accountId } = await seedAccountWorkspace();
    // Original plan: limit 1000 conversations -> grace floor(1000 * 0.1) = 100 conversations.
    await assignProfile(accountId, { monthlyConversationLimit: 1000 });

    // Carry 100 conversations (1000 tenths) of debt -- exactly at the original plan's grace floor.
    await database.query(
      `INSERT INTO ee_usage_limit_credits (account_id, balance_tenths) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET balance_tenths = $2`,
      [accountId, -tenths(100)],
    );

    // Downgrade: the new plan's grace (floor(50 * 0.1) = 5 conversations) is far smaller than the carried debt.
    await assignProfile(accountId, { monthlyConversationLimit: 50 });
    const limitTenths = tenths(50);
    const profile = fakeConversationProfile(limitTenths);
    const service = new EnterpriseUsageLimitService(database);
    const nextPeriod = "2031-04-01";

    // Seed the fresh period one conversation short of the new, smaller limit.
    await database.query(
      `INSERT INTO ee_usage_limit_unit_counters (account_id, period_start, used_tenths) VALUES ($1, $2::date, $3)`,
      [accountId, nextPeriod, limitTenths - tenths(1)],
    );

    // The last conversation of the full fresh allowance still succeeds: carried debt from the
    // old, larger profile never ate into the new period's allowance.
    await reserveTenthsDirect(service, accountId, profile, nextPeriod, "conversation", tenths(1), limitTenths);

    // The next one would overshoot the allowance, and the carried debt (100 conversations)
    // already exceeds the new grace (5 conversations): zero borrowing room, refused immediately.
    await expect(reserveTenthsDirect(service, accountId, profile, nextPeriod, "conversation", tenths(1), limitTenths))
      .rejects.toBeInstanceOf(UsageLimitExceededError);

    const credits = await database.query<{ balance_tenths: number }>(
      `SELECT balance_tenths FROM ee_usage_limit_credits WHERE account_id = $1`,
      [accountId],
    );
    expect(credits[0].balance_tenths).toBe(-tenths(100));
  });

  it("locks the credits row so two concurrent reservations in different periods never both borrow past the floor", async () => {
    const { accountId } = await seedAccountWorkspace();
    // limit 10 conversations -> grace floor(10 * 0.1) = 1 conversation (10 tenths).
    const limitTenths = tenths(10);
    const profile = fakeConversationProfile(limitTenths);
    const service = new EnterpriseUsageLimitService(database);

    // Two distinct periods (simulating a UTC month rollover splitting concurrent traffic across
    // two counter rows), each already sitting at the plan limit, so each reservation below is a
    // one-conversation overshoot that must draw on the single, account-wide grace.
    const periodA = "2031-05-01";
    const periodB = "2031-06-01";
    await database.query(
      `INSERT INTO ee_usage_limit_unit_counters (account_id, period_start, used_tenths) VALUES
         ($1, $2::date, $3), ($1, $4::date, $3)`,
      [accountId, periodA, limitTenths, periodB],
    );
    // Pre-create the credits row so both reservations' own `INSERT ... ON CONFLICT DO NOTHING`
    // is a true no-op against an already-committed row. Racing that insert on a not-yet-existing
    // row would itself serialize the two transactions on the unique index, which would mask
    // exactly the bug this test exists to catch.
    await database.query(
      `INSERT INTO ee_usage_limit_credits (account_id, balance_tenths) VALUES ($1, 0)`,
      [accountId],
    );

    // Pre-warm two idle pool connections. Otherwise the first reservation below reuses an
    // already-established idle connection while the second pays real connect-handshake latency,
    // which reliably lets the first finish its whole transaction before the second's connection
    // is even open -- serializing them by accident and masking the very race this test targets.
    await Promise.all([database.query("SELECT 1"), database.query("SELECT 1")]);

    const [resultA, resultB] = await Promise.allSettled([
      reserveTenthsDirect(service, accountId, profile, periodA, "conversation", tenths(1), limitTenths),
      reserveTenthsDirect(service, accountId, profile, periodB, "conversation", tenths(1), limitTenths),
    ]);
    const outcomes = [resultA, resultB];

    // The grace floor (1 conversation) can only ever admit one of the two: locking the credits
    // row serializes them so the second sees the first's already-decremented balance, rather
    // than both reading the same stale balance and both pushing it past the floor.
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(UsageLimitExceededError);

    const credits = await database.query<{ balance_tenths: number }>(
      `SELECT balance_tenths FROM ee_usage_limit_credits WHERE account_id = $1`,
      [accountId],
    );
    // Exactly the grace floor -- never twice that, which is what the unlocked read allowed.
    expect(credits[0].balance_tenths).toBe(-tenths(1));
  });
});
