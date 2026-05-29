import { describe, expect, it } from "vitest";

import {
  DurableUsageEventRecorder,
  type TransactionalUsageEventDatabase,
  type UsageEventDatabaseClient,
} from "../../src/shared/infra/usage/durableUsageEventRecorder.js";

interface UsageEventRow {
  id: string;
  idempotency_key: string;
  account_id: string | null;
  workspace_id: string;
  source_id: string | null;
  document_id: string | null;
  document_revision: number | null;
  conversation_id: string | null;
  message_id: string | null;
  job_id: string | null;
  surface: string;
  operation: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_bytes: number;
  output_bytes: number;
  vector_count: number;
  status: string;
  usage_quality: string;
  provider_request_id: string | null;
  error_code: string | null;
  occurred_at: string;
}

interface EmbeddingItemRow {
  usage_event_id: string;
  document_id: string;
  document_revision: number;
  chunk_id: string | null;
  chunk_index: number;
  content_bytes: number;
  estimated_tokens: number | null;
}

interface RollupKey {
  account_id: string;
  usage_date: string;
  operation: string;
  provider: string;
  model: string;
}
interface RollupRow extends RollupKey {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_bytes: number;
  output_bytes: number;
  vector_count: number;
}

class FakeRecorderDatabase implements TransactionalUsageEventDatabase {
  readonly workspaceAccounts = new Map<string, string>();
  readonly events = new Map<string, UsageEventRow>();
  readonly idempotencyKeys = new Map<string, string>();
  readonly embeddingItems: EmbeddingItemRow[] = [];
  readonly rollups = new Map<string, RollupRow>();
  throwOnRollup = false;

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    if (text.includes("SELECT account_id FROM workspaces")) {
      const accountId = this.workspaceAccounts.get(String(params[0]));
      return (accountId ? [{ account_id: accountId }] : []) as T[];
    }
    if (text.includes("INSERT INTO usage_events") && text.includes("ON CONFLICT (idempotency_key) DO NOTHING")) {
      const isEmbedding = text.includes("'embedding', 'embedding'");
      return this.insertEvent(params, isEmbedding) as T[];
    }
    if (text.includes("INSERT INTO embedding_usage_items")) {
      for (let index = 0; index < params.length; index += 7) {
        this.embeddingItems.push({
          usage_event_id: String(params[index]),
          document_id: String(params[index + 1]),
          document_revision: Number(params[index + 2]),
          chunk_id: (params[index + 3] as string | null) ?? null,
          chunk_index: Number(params[index + 4]),
          content_bytes: Number(params[index + 5]),
          estimated_tokens: params[index + 6] === null ? null : Number(params[index + 6]),
        });
      }
      return [] as T[];
    }
    if (text.includes("INSERT INTO usage_daily_rollups")) {
      if (this.throwOnRollup) {
        throw new Error("rollup unavailable");
      }
      const key: RollupKey = {
        account_id: String(params[0]),
        usage_date: String(params[1]),
        operation: String(params[2]),
        provider: String(params[3]),
        model: String(params[4]),
      };
      const composite = `${key.account_id}|${key.usage_date}|${key.operation}|${key.provider}|${key.model}`;
      const existing = this.rollups.get(composite);
      const next: RollupRow = existing
        ? {
            ...existing,
            input_tokens: existing.input_tokens + Number(params[5]),
            output_tokens: existing.output_tokens + Number(params[6]),
            total_tokens: existing.total_tokens + Number(params[7]),
            input_bytes: existing.input_bytes + Number(params[8]),
            output_bytes: existing.output_bytes + Number(params[9]),
            vector_count: existing.vector_count + Number(params[10]),
          }
        : {
            ...key,
            input_tokens: Number(params[5]),
            output_tokens: Number(params[6]),
            total_tokens: Number(params[7]),
            input_bytes: Number(params[8]),
            output_bytes: Number(params[9]),
            vector_count: Number(params[10]),
          };
      this.rollups.set(composite, next);
      return [] as T[];
    }
    return [] as T[];
  }

  async withTransaction<T>(callback: (client: UsageEventDatabaseClient) => Promise<T>): Promise<T> {
    const events = new Map(this.events);
    const idempotencyKeys = new Map(this.idempotencyKeys);
    const embeddingItems = [...this.embeddingItems];
    const rollups = new Map(this.rollups);
    try {
      return await callback(this);
    } catch (error) {
      this.events.clear();
      for (const [key, value] of events) this.events.set(key, value);
      this.idempotencyKeys.clear();
      for (const [key, value] of idempotencyKeys) this.idempotencyKeys.set(key, value);
      this.embeddingItems.splice(0, this.embeddingItems.length, ...embeddingItems);
      this.rollups.clear();
      for (const [key, value] of rollups) this.rollups.set(key, value);
      throw error;
    }
  }

  private insertEvent(params: unknown[], isEmbedding: boolean): Array<{ id: string }> {
    const idempotencyKey = String(params[1]);
    if (this.idempotencyKeys.has(idempotencyKey)) {
      return [];
    }
    const id = String(params[0]);
    this.idempotencyKeys.set(idempotencyKey, id);
    if (isEmbedding) {
      const row: UsageEventRow = {
        id,
        idempotency_key: idempotencyKey,
        account_id: (params[2] as string | null) ?? null,
        workspace_id: String(params[3]),
        source_id: (params[4] as string | null) ?? null,
        document_id: (params[5] as string | null) ?? null,
        document_revision: params[6] === null ? null : Number(params[6]),
        conversation_id: null,
        message_id: null,
        job_id: (params[7] as string | null) ?? null,
        surface: "embedding",
        operation: "embedding",
        provider: String(params[8]),
        model: String(params[9]),
        input_tokens: Number(params[10]),
        output_tokens: Number(params[11]),
        total_tokens: Number(params[12]),
        input_bytes: Number(params[13]),
        output_bytes: 0,
        vector_count: Number(params[14]),
        status: String(params[15]),
        usage_quality: String(params[16]),
        provider_request_id: (params[17] as string | null) ?? null,
        error_code: (params[18] as string | null) ?? null,
        occurred_at: String(params[19]),
      };
      this.events.set(id, row);
    } else {
      const row: UsageEventRow = {
        id,
        idempotency_key: idempotencyKey,
        account_id: (params[2] as string | null) ?? null,
        workspace_id: String(params[3]),
        source_id: null,
        document_id: null,
        document_revision: null,
        conversation_id: (params[4] as string | null) ?? null,
        message_id: (params[5] as string | null) ?? null,
        job_id: null,
        surface: String(params[6]),
        operation: String(params[7]),
        provider: String(params[8]),
        model: String(params[9]),
        input_tokens: Number(params[10]),
        output_tokens: Number(params[11]),
        total_tokens: Number(params[12]),
        input_bytes: Number(params[13]),
        output_bytes: Number(params[14]),
        vector_count: 0,
        status: String(params[15]),
        usage_quality: String(params[16]),
        provider_request_id: (params[17] as string | null) ?? null,
        error_code: (params[18] as string | null) ?? null,
        occurred_at: String(params[19]),
      };
      this.events.set(id, row);
    }
    return [{ id }];
  }
}

describe("durable usage event recorder", () => {
  it("inserts an embedding event with lineage and updates the daily rollup", async () => {
    const database = new FakeRecorderDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const recorder = new DurableUsageEventRecorder(database);

    await recorder.recordEmbedding({
      idempotencyKey: "embed:workspace-1:doc-1:3:0:openai:text-embedding-3-small",
      workspaceId: "workspace-1",
      documentId: "doc-1",
      documentRevision: 3,
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 200,
      inputBytes: 1024,
      vectorCount: 1,
      status: "succeeded",
      usageQuality: "actual",
      chunks: [
        { chunkIndex: 0, contentBytes: 512, estimatedTokens: 128 },
      ],
    });

    expect(database.events.size).toBe(1);
    const [event] = [...database.events.values()];
    expect(event.account_id).toBe("account-1");
    expect(event.operation).toBe("embedding");
    expect(event.input_tokens).toBe(200);
    expect(event.total_tokens).toBe(200);
    expect(database.embeddingItems).toHaveLength(1);
    expect(database.rollups.size).toBe(1);
    const [rollup] = [...database.rollups.values()];
    expect(rollup.input_tokens).toBe(200);
    expect(rollup.vector_count).toBe(1);
  });

  it("does not double-count when the same idempotency key is recorded twice", async () => {
    const database = new FakeRecorderDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const recorder = new DurableUsageEventRecorder(database);
    const event = {
      idempotencyKey: "embed:workspace-1:doc-1:1:0:openai:text-embedding-3-small",
      workspaceId: "workspace-1",
      documentId: "doc-1",
      documentRevision: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 100,
      inputBytes: 256,
      vectorCount: 1,
      status: "succeeded" as const,
      usageQuality: "actual" as const,
    };

    await recorder.recordEmbedding(event);
    await recorder.recordEmbedding(event);

    expect(database.events.size).toBe(1);
    const [row] = [...database.rollups.values()];
    expect(row.input_tokens).toBe(100);
  });

  it("keeps failed embedding events diagnostic-only and out of daily rollups", async () => {
    const database = new FakeRecorderDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const recorder = new DurableUsageEventRecorder(database);

    await recorder.recordEmbedding({
      idempotencyKey: "embed:workspace-1:doc-1:1:job-1:chunks:a:openai:text-embedding-3-small:failed",
      workspaceId: "workspace-1",
      documentId: "doc-1",
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

    expect(database.events.size).toBe(1);
    const [event] = [...database.events.values()];
    expect(event.input_tokens).toBe(100);
    expect(event.vector_count).toBe(1);
    expect(event.status).toBe("failed");
    expect(database.rollups.size).toBe(0);
  });

  it("keeps embedding ledger events when the derived rollup update fails", async () => {
    const database = new FakeRecorderDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    database.throwOnRollup = true;
    const warnings: unknown[][] = [];
    const recorder = new DurableUsageEventRecorder(database, {
      warn(...args: unknown[]) {
        warnings.push(args);
      },
    });

    await recorder.recordEmbedding({
      idempotencyKey: "embed:workspace-1:doc-1:1:job-1:chunks:a:openai:text-embedding-3-small:succeeded",
      workspaceId: "workspace-1",
      documentId: "doc-1",
      documentRevision: 1,
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: 100,
      inputBytes: 256,
      vectorCount: 1,
      status: "succeeded",
      usageQuality: "actual",
    });

    expect(database.events.size).toBe(1);
    expect(database.idempotencyKeys.size).toBe(1);
    expect(database.rollups.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it("records model usage events with conversation lineage", async () => {
    const database = new FakeRecorderDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    const recorder = new DurableUsageEventRecorder(database);

    await recorder.recordModelCall({
      idempotencyKey: "answer:conv-1:msg-1:openai:gpt-5.2:attempt-1",
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "gpt-5.2",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      status: "succeeded",
      usageQuality: "actual",
    });

    const [event] = [...database.events.values()];
    expect(event.conversation_id).toBe("conv-1");
    expect(event.operation).toBe("answer");
    expect(event.total_tokens).toBe(1500);
  });

  it("keeps model ledger events when the derived rollup update fails", async () => {
    const database = new FakeRecorderDatabase();
    database.workspaceAccounts.set("workspace-1", "account-1");
    database.throwOnRollup = true;
    const warnings: unknown[][] = [];
    const recorder = new DurableUsageEventRecorder(database, {
      warn(...args: unknown[]) {
        warnings.push(args);
      },
    });

    await recorder.recordModelCall({
      idempotencyKey: "answer:conv-1:msg-1:openai:gpt-5.2:attempt-1",
      workspaceId: "workspace-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "gpt-5.2",
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
      status: "succeeded",
      usageQuality: "actual",
    });

    expect(database.events.size).toBe(1);
    expect(database.rollups.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});
