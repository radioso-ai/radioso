import { randomUUID } from "node:crypto";

import type {
  UsageLimitDatabaseClient,
  UsageLimitDatabasePort,
} from "../radiosoModuleTypes.js";

export interface TransactionalUsageEventDatabasePort extends UsageLimitDatabasePort {
  withTransaction<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T>;
}

export const requireTransactionalUsageEventDatabase = (
  database: UsageLimitDatabasePort,
): TransactionalUsageEventDatabasePort => {
  if (!database.withTransaction) {
    throw new Error("Usage event recording requires transactional database support");
  }
  return database as TransactionalUsageEventDatabasePort;
};

export type UsageEventStatus = "succeeded" | "failed";
export type UsageEventQuality = "actual" | "estimated";

export interface EmbeddingUsageEvent {
  idempotencyKey: string;
  accountId?: string | null;
  workspaceId: string;
  sourceId?: string | null;
  documentId: string;
  documentRevision: number;
  jobId?: string | null;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  inputBytes: number;
  vectorCount: number;
  status: UsageEventStatus;
  usageQuality: UsageEventQuality;
  providerRequestId?: string | null;
  errorCode?: string | null;
  occurredAt?: Date;
  chunks?: Array<{
    chunkIndex: number;
    chunkId?: string | null;
    contentBytes: number;
    estimatedTokens?: number | null;
  }>;
}

export interface ModelUsageEvent {
  idempotencyKey: string;
  accountId?: string | null;
  workspaceId: string;
  conversationId?: string | null;
  messageId?: string | null;
  surface: string;
  operation: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  status: UsageEventStatus;
  usageQuality: UsageEventQuality;
  providerRequestId?: string | null;
  errorCode?: string | null;
  occurredAt?: Date;
}

const queryRows = async <T = Record<string, unknown>>(
  client: UsageLimitDatabaseClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await client.query<T>(text, params);
  return Array.isArray(result) ? result : result.rows;
};

const toIsoDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const resolveAccountId = async (
  database: UsageLimitDatabasePort,
  input: { accountId?: string | null; workspaceId: string },
): Promise<string | null> => {
  if (input.accountId) {
    return input.accountId;
  }
  const [workspace] = await queryRows<{ account_id: string }>(
    database,
    `SELECT account_id FROM workspaces WHERE id = $1`,
    [input.workspaceId],
  );
  return workspace?.account_id ?? null;
};

export class EnterpriseUsageEventRecorder {
  constructor(private readonly database: TransactionalUsageEventDatabasePort) {}

  async recordEmbedding(event: EmbeddingUsageEvent): Promise<void> {
    const accountId = await resolveAccountId(this.database, {
      accountId: event.accountId,
      workspaceId: event.workspaceId,
    });
    const occurredAt = event.occurredAt ?? new Date();
    const totalTokens =
      (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    const eventId = randomUUID();

    await this.withTransaction(async (client) => {
      const inserted = await queryRows<{ id: string }>(
        client,
        `INSERT INTO ee_usage_events (
         id,
         idempotency_key,
         account_id,
         workspace_id,
         source_id,
         document_id,
         document_revision,
         job_id,
         surface,
         operation,
         provider,
         model,
         input_tokens,
         output_tokens,
         total_tokens,
         input_bytes,
         output_bytes,
         vector_count,
         status,
         usage_quality,
         provider_request_id,
         error_code,
         occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'embedding', 'embedding', $9, $10, $11, $12, $13, $14, 0, $15, $16, $17, $18, $19, $20::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
        [
          eventId,
          event.idempotencyKey,
          accountId,
          event.workspaceId,
          event.sourceId ?? null,
          event.documentId,
          event.documentRevision,
          event.jobId ?? null,
          event.provider,
          event.model,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          totalTokens,
          event.inputBytes,
          event.vectorCount,
          event.status,
          event.usageQuality,
          event.providerRequestId ?? null,
          event.errorCode ?? null,
          occurredAt.toISOString(),
        ],
      );

      if (inserted.length === 0) {
        return;
      }
      const insertedId = inserted[0].id;

      if (event.chunks && event.chunks.length > 0) {
        await this.insertEmbeddingItems(client, {
          usageEventId: insertedId,
          documentId: event.documentId,
          documentRevision: event.documentRevision,
          chunks: event.chunks,
        });
      }

      if (accountId && event.status === "succeeded") {
        await this.upsertDailyRollup(client, accountId, occurredAt, {
          operation: "embedding",
          provider: event.provider,
          model: event.model,
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          totalTokens,
          inputBytes: event.inputBytes,
          outputBytes: 0,
          vectorCount: event.vectorCount,
        });
      }
    });
  }

  private async insertEmbeddingItems(
    client: UsageLimitDatabaseClient,
    input: {
      usageEventId: string;
      documentId: string;
      documentRevision: number;
      chunks: NonNullable<EmbeddingUsageEvent["chunks"]>;
    },
  ): Promise<void> {
    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    input.chunks.forEach((chunk, index) => {
      const offset = index * 7;
      valuePlaceholders.push(
        `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`,
      );
      params.push(
        input.usageEventId,
        input.documentId,
        input.documentRevision,
        chunk.chunkId ?? null,
        chunk.chunkIndex,
        chunk.contentBytes,
        chunk.estimatedTokens ?? null,
      );
    });

    await queryRows(
      client,
      `INSERT INTO ee_embedding_usage_items (
             usage_event_id,
             document_id,
             document_revision,
             chunk_id,
             chunk_index,
             content_bytes,
             estimated_tokens
           )
       VALUES ${valuePlaceholders.join(", ")}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }

  async recordModelCall(event: ModelUsageEvent): Promise<void> {
    const accountId = await resolveAccountId(this.database, {
      accountId: event.accountId,
      workspaceId: event.workspaceId,
    });
    const occurredAt = event.occurredAt ?? new Date();
    const totalTokens = event.totalTokens ?? ((event.inputTokens ?? 0) + (event.outputTokens ?? 0));
    const eventId = randomUUID();

    await this.withTransaction(async (client) => {
      const inserted = await queryRows<{ id: string }>(
        client,
        `INSERT INTO ee_usage_events (
         id,
         idempotency_key,
         account_id,
         workspace_id,
         conversation_id,
         message_id,
         surface,
         operation,
         provider,
         model,
         input_tokens,
         output_tokens,
         total_tokens,
         input_bytes,
         output_bytes,
         vector_count,
         status,
         usage_quality,
         provider_request_id,
         error_code,
         occurred_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 0, $16, $17, $18, $19, $20::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
        [
          eventId,
          event.idempotencyKey,
          accountId,
          event.workspaceId,
          event.conversationId ?? null,
          event.messageId ?? null,
          event.surface,
          event.operation,
          event.provider,
          event.model,
          event.inputTokens ?? 0,
          event.outputTokens ?? 0,
          totalTokens,
          event.inputBytes ?? 0,
          event.outputBytes ?? 0,
          event.status,
          event.usageQuality,
          event.providerRequestId ?? null,
          event.errorCode ?? null,
          occurredAt.toISOString(),
        ],
      );

      if (inserted.length === 0) {
        return;
      }

      if (accountId && event.status === "succeeded") {
        await this.upsertDailyRollup(client, accountId, occurredAt, {
          operation: event.operation,
          provider: event.provider,
          model: event.model,
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          totalTokens,
          inputBytes: event.inputBytes ?? 0,
          outputBytes: event.outputBytes ?? 0,
          vectorCount: 0,
        });
      }
    });
  }

  private async upsertDailyRollup(
    client: UsageLimitDatabaseClient,
    accountId: string,
    occurredAt: Date,
    deltas: {
      operation: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      inputBytes: number;
      outputBytes: number;
      vectorCount: number;
    },
  ): Promise<void> {
    await queryRows(
      client,
      `INSERT INTO ee_usage_daily_rollups (
         account_id,
         usage_date,
         operation,
         provider,
         model,
         input_tokens,
         output_tokens,
         total_tokens,
         input_bytes,
         output_bytes,
         vector_count
       )
       VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (account_id, usage_date, operation, provider, model)
       DO UPDATE SET
         input_tokens = ee_usage_daily_rollups.input_tokens + EXCLUDED.input_tokens,
         output_tokens = ee_usage_daily_rollups.output_tokens + EXCLUDED.output_tokens,
         total_tokens = ee_usage_daily_rollups.total_tokens + EXCLUDED.total_tokens,
         input_bytes = ee_usage_daily_rollups.input_bytes + EXCLUDED.input_bytes,
         output_bytes = ee_usage_daily_rollups.output_bytes + EXCLUDED.output_bytes,
         vector_count = ee_usage_daily_rollups.vector_count + EXCLUDED.vector_count`,
      [
        accountId,
        toIsoDate(occurredAt),
        deltas.operation,
        deltas.provider,
        deltas.model,
        deltas.inputTokens,
        deltas.outputTokens,
        deltas.totalTokens,
        deltas.inputBytes,
        deltas.outputBytes,
        deltas.vectorCount,
      ],
    );
  }

  private async withTransaction<T>(callback: (client: UsageLimitDatabaseClient) => Promise<T>): Promise<T> {
    return this.database.withTransaction(callback);
  }
}
