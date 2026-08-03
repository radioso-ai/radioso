import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountRepository } from "../../src/db/repositories/accountRepository.js";
import { DocumentRepository } from "../../src/db/repositories/documentRepository.js";
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
  const detailDimensionsMigrationFile = "134_usage_event_detail_dimensions.sql";

  let database: Database;
  let accountRepository: AccountRepository;
  let workspaceRepository: WorkspaceRepository;
  let documentRepository: DocumentRepository;

  beforeAll(async () => {
    database = new Database(integrationDatabaseUrl!);
    accountRepository = new AccountRepository(database.kysely);
    workspaceRepository = new WorkspaceRepository(database.kysely);
    documentRepository = new DocumentRepository(database.kysely);
    await runAllTestMigrations(database);
  });

  const seedDocument = async (workspaceId: string): Promise<string> => {
    const document = await documentRepository.create({
      workspaceId,
      title: "Usage Doc",
      sourceContent: "content",
      markdownContent: "content",
      status: "ready",
    });
    return document.id;
  };

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
    const recorder = new DurableUsageEventRecorder(database.kysely);
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
      reasoningTokens: 8,
      totalTokens: 120,
      status: "succeeded",
      usageQuality: "actual",
    });

    const rows = await database.query<{
      total_tokens: string;
      operation: string;
      reasoning_tokens: string | null;
      event_kind: string;
    }>(
      "SELECT total_tokens, operation, reasoning_tokens, event_kind FROM usage_events WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("answer");
    expect(Number(rows[0].total_tokens)).toBe(120);
    expect(Number(rows[0].reasoning_tokens)).toBe(8);
    expect(rows[0].event_kind).toBe("model");
  });

  it("does not double-count a replayed idempotency key", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database.kysely);
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

  it("records an embedding event with chunk lineage and updates the daily rollup", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database.kysely);
    const idempotencyKey = `embed:${randomUUID()}`;
    const documentId = await seedDocument(workspaceId);

    await recorder.recordEmbedding({
      idempotencyKey,
      workspaceId,
      documentId,
      documentRevision: 3,
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 200,
      inputBytes: 1024,
      vectorCount: 1,
      status: "succeeded",
      usageQuality: "actual",
      chunks: [{ chunkIndex: 0, contentBytes: 512, estimatedTokens: 128 }],
    });

    const events = await database.query<{
      id: string;
      operation: string;
      total_tokens: string;
      vector_count: string;
      event_kind: string;
      reasoning_tokens: string | null;
    }>(
      "SELECT id, operation, total_tokens, vector_count, event_kind, reasoning_tokens FROM usage_events WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(events).toHaveLength(1);
    expect(events[0].operation).toBe("embedding");
    expect(Number(events[0].total_tokens)).toBe(200);
    expect(Number(events[0].vector_count)).toBe(1);
    expect(events[0].event_kind).toBe("embedding");
    expect(events[0].reasoning_tokens).toBeNull();

    const items = await database.query<{ chunk_index: number; content_bytes: string }>(
      "SELECT chunk_index, content_bytes FROM embedding_usage_items WHERE usage_event_id = $1",
      [events[0].id],
    );
    expect(items).toHaveLength(1);
    expect(Number(items[0].content_bytes)).toBe(512);

    const rollups = await database.query<{ input_tokens: string; vector_count: string }>(
      "SELECT input_tokens, vector_count FROM usage_daily_rollups WHERE account_id = $1 AND operation = 'embedding'",
      [accountId],
    );
    expect(rollups).toHaveLength(1);
    expect(Number(rollups[0].input_tokens)).toBe(200);
    expect(Number(rollups[0].vector_count)).toBe(1);
  });

  it("keeps a failed embedding event diagnostic-only and out of the daily rollup", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database.kysely);
    const idempotencyKey = `embed-failed:${randomUUID()}`;
    const documentId = await seedDocument(workspaceId);

    await recorder.recordEmbedding({
      idempotencyKey,
      workspaceId,
      documentId,
      documentRevision: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 100,
      inputBytes: 256,
      vectorCount: 1,
      status: "failed",
      usageQuality: "estimated",
      errorCode: "provider_timeout",
    });

    const events = await database.query<{ status: string }>(
      "SELECT status FROM usage_events WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe("failed");

    const rollups = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM usage_daily_rollups WHERE account_id = $1",
      [accountId],
    );
    expect(Number(rollups[0].count)).toBe(0);
  });

  it("classifies historical rows only when durable evidence exists", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const keyPrefix = `usage-history-test-${randomUUID()}`;
    const modelKey = `model:${keyPrefix}`;
    const embeddingKey = `embedding:${keyPrefix}`;
    const unknownKey = `legacy:${keyPrefix}`;

    // Simulate the nullable column state immediately after it is added, then
    // replay the real migration. A failed zero-vector legacy row has no durable
    // proof of its type and must remain unknown.
    await database.query("ALTER TABLE usage_events ALTER COLUMN event_kind DROP NOT NULL");
    await database.query(
      `INSERT INTO usage_events (
         id, idempotency_key, account_id, workspace_id, surface, operation, provider, model,
         input_tokens, output_tokens, total_tokens, vector_count, event_kind, status, usage_quality, occurred_at
       ) VALUES
         ($1, $2, $3, $4, 'assistant', 'answer', 'openai', 'gpt-test', 1, 1, 2, 0, NULL, 'succeeded', 'actual', NOW()),
         ($5, $6, $3, $4, 'documents', 'embedding', 'openai', 'text-embedding-3-small', 1, 0, 1, 0, NULL, 'failed', 'estimated', NOW()),
         ($7, $8, $3, $4, 'legacy', 'unknown', 'openai', 'old-model', 1, 0, 1, 0, NULL, 'failed', 'estimated', NOW())`,
      [randomUUID(), modelKey, accountId, workspaceId, randomUUID(), embeddingKey, randomUUID(), unknownKey],
    );

    const migrationSql = await readFile(path.join(testMigrationsPath, detailDimensionsMigrationFile), "utf8");
    await database.pool.query(migrationSql);

    const rows = await database.query<{ idempotency_key: string; event_kind: string }>(
      "SELECT idempotency_key, event_kind FROM usage_events WHERE idempotency_key IN ($1, $2, $3)",
      [modelKey, embeddingKey, unknownKey],
    );
    expect(Object.fromEntries(rows.map((row) => [row.idempotency_key, row.event_kind]))).toEqual({
      [modelKey]: "model",
      [embeddingKey]: "embedding",
      [unknownKey]: "unknown",
    });
  });

  it("renames legacy ee_usage_* tables in place without losing rows", async () => {
    const { accountId, workspaceId } = await seedWorkspace();
    const recorder = new DurableUsageEventRecorder(database.kysely);
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
