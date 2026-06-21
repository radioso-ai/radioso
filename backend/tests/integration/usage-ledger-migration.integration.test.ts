import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { WorkspaceRepository } from "../../src/db/repositories/workspaceRepository.js";
import { Database } from "../../src/shared/infra/database.js";
import { DurableUsageEventRecorder } from "../../src/shared/infra/usage/durableUsageEventRecorder.js";
import { runAllTestMigrations, testMigrationsPath } from "../support/databaseMigrations.js";

// Phase 2 OSS ledger migration. Proves the durable recorder works end-to-end
// against real Postgres on the renamed `usage_events` schema, that recording is
// idempotent (SC-005), and that the 067 migration renames legacy `ee_usage_*`
// tables in place WITHOUT losing data. Gated on INTEGRATION_DATABASE_URL; skips
// when no database is reachable (e.g. unit-only CI lanes).
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const database = new Database(databaseUrl);
  try {
    await database.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await database.close().catch(() => undefined);
  }
};

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("usage ledger OSS migration", () => {
  const ledgerMigrationFile = "067_usage_ledger_oss.sql";

  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const seedWorkspace = async () => {
    const account = await accountRepository.create({
      name: "Usage Org",
      email: `usage-${randomUUID()}@example.com`,
      passwordHash: "hash",
    });
    const workspace = await workspaceRepository.create(account.id, "Usage Workspace");
    return { accountId: account.id, workspaceId: workspace.id };
  };

  it("records a model usage event into the OSS usage_events table", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database);
    const idempotencyKey = `answer:${randomUUID()}`;

    await recorder.recordModelCall({
      idempotencyKey,
      accountId,
      workspaceId,
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      status: "succeeded",
      usageQuality: "actual",
    });

    const rows = await database.query<{ total_tokens: string; operation: string }>(
      "SELECT total_tokens, operation FROM usage_events WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("answer");
    expect(Number(rows[0].total_tokens)).toBe(120);
  });

  it("does not double-count a replayed idempotency key", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database);
    const idempotencyKey = `answer:${randomUUID()}`;
    const event = {
      idempotencyKey,
      accountId,
      workspaceId,
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      status: "succeeded" as const,
      usageQuality: "actual" as const,
    };

    await recorder.recordModelCall(event);
    await recorder.recordModelCall(event);

    const rows = await database.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM usage_events WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("renames legacy ee_usage_* tables in place without losing rows", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database);
    const idempotencyKey = `legacy:${randomUUID()}`;

    // Seed a row, then simulate a pre-migration install by renaming the event
    // tables back to their legacy ee_* names (FKs follow the rename).
    await recorder.recordModelCall({
      idempotencyKey,
      accountId,
      workspaceId,
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      status: "succeeded",
      usageQuality: "actual",
    });

    await database.pool.query("ALTER TABLE usage_events RENAME TO ee_usage_events");
    await database.pool.query("ALTER TABLE embedding_usage_items RENAME TO ee_embedding_usage_items");
    await database.pool.query("ALTER TABLE usage_daily_rollups RENAME TO ee_usage_daily_rollups");

    // Re-apply the real migration; its IF EXISTS renames restore the OSS names
    // and the IF NOT EXISTS creates are no-ops, so the seeded row must survive.
    const ledgerSql = await readFile(path.join(testMigrationsPath, ledgerMigrationFile), "utf8");
    await database.pool.query(ledgerSql);

    const rows = await database.query<{ total_tokens: string }>(
      "SELECT total_tokens FROM usage_events WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_tokens)).toBe(15);
  });
});
