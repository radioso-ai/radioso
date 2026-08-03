import { randomUUID } from "node:crypto";

import type {
  EmbeddingUsageEvent,
  ModelUsageEvent,
  UsageEventRecorder,
} from "../../domain/usageEventRecorder.js";
import type { Db } from "../kysely/types.js";
import type { AppLogger } from "../../observability/logger.js";

const toIsoDate = (date: Date): string =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;

const resolveAccountId = async (
  db: Db,
  input: { accountId?: string | null; workspaceId: string },
): Promise<string | null> => {
  if (input.accountId) {
    return input.accountId;
  }
  const workspace = await db
    .selectFrom("workspaces")
    .select("account_id")
    .where("id", "=", input.workspaceId)
    .executeTakeFirst();
  return workspace?.account_id ?? null;
};

/**
 * OSS durable usage-event recorder. Writes immutable events to `usage_events`
 * (plus `embedding_usage_items`) and best-effort maintains the derived
 * `usage_daily_rollups` cache after the authoritative event transaction commits.
 * Idempotent on `idempotency_key`: a repeated attempt inserts nothing and skips
 * the rollup, so replays never inflate totals.
 *
 * Ledger insertion is authoritative. The daily rollup is a rebuildable cache
 * derived from these events (see migration `067_usage_ledger_oss.sql`); a future
 * delivery phase owns the rebuild/recovery job and richer summary read-models.
 */
export class DurableUsageEventRecorder implements UsageEventRecorder {
  constructor(
    private readonly db: Db,
    private readonly logger?: Pick<AppLogger, "warn">,
  ) {}

  async recordEmbedding(event: EmbeddingUsageEvent): Promise<void> {
    const accountId = await resolveAccountId(this.db, {
      accountId: event.accountId,
      workspaceId: event.workspaceId,
    });
    const occurredAt = event.occurredAt ?? new Date();
    const totalTokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
    const eventId = randomUUID();

    const inserted = await this.db.transaction().execute(async (trx) => {
      const insertedRow = await trx
        .insertInto("usage_events")
        .values({
          id: eventId,
          idempotency_key: event.idempotencyKey,
          account_id: accountId,
          workspace_id: event.workspaceId,
          agent_id: event.agentId ?? null,
          source_id: event.sourceId ?? null,
          document_id: event.documentId ?? null,
          document_revision: event.documentRevision ?? null,
          conversation_id: event.conversationId ?? null,
          message_id: event.messageId ?? null,
          job_id: event.jobId ?? null,
          surface: event.surface ?? "embedding",
          operation: event.operation ?? "embedding",
          provider: event.provider,
          model: event.model,
          input_tokens: event.inputTokens ?? 0,
          output_tokens: event.outputTokens ?? 0,
          total_tokens: totalTokens,
          input_bytes: event.inputBytes,
          output_bytes: 0,
          vector_count: event.vectorCount,
          event_kind: "embedding",
          status: event.status,
          usage_quality: event.usageQuality,
          provider_request_id: event.providerRequestId ?? null,
          error_code: event.errorCode ?? null,
          occurred_at: occurredAt,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .returning("id")
        .executeTakeFirst();

      if (!insertedRow) {
        return false;
      }
      const insertedId = insertedRow.id;

      if (event.chunks && event.chunks.length > 0) {
        if (!event.documentId || event.documentRevision === null || event.documentRevision === undefined) {
          this.logger?.warn(
            { workspaceId: event.workspaceId, idempotencyKey: event.idempotencyKey },
            "Embedding usage event included chunk items without document lineage",
          );
          return true;
        }
        await this.insertEmbeddingItems(trx, {
          usageEventId: insertedId,
          documentId: event.documentId,
          documentRevision: event.documentRevision,
          chunks: event.chunks,
        });
      }

      return true;
    });

    if (inserted && accountId && event.status === "succeeded") {
      await this.upsertDailyRollupBestEffort(accountId, occurredAt, {
        operation: event.operation ?? "embedding",
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
  }

  private async insertEmbeddingItems(
    db: Db,
    input: {
      usageEventId: string;
      documentId: string;
      documentRevision: number;
      chunks: NonNullable<EmbeddingUsageEvent["chunks"]>;
    },
  ): Promise<void> {
    await db
      .insertInto("embedding_usage_items")
      .values(
        input.chunks.map((chunk) => ({
          usage_event_id: input.usageEventId,
          document_id: input.documentId,
          document_revision: input.documentRevision,
          chunk_id: chunk.chunkId ?? null,
          chunk_index: chunk.chunkIndex,
          content_bytes: chunk.contentBytes,
          estimated_tokens: chunk.estimatedTokens ?? null,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async recordModelCall(event: ModelUsageEvent): Promise<void> {
    const accountId = await resolveAccountId(this.db, {
      accountId: event.accountId,
      workspaceId: event.workspaceId,
    });
    const occurredAt = event.occurredAt ?? new Date();
    const totalTokens = event.totalTokens ?? ((event.inputTokens ?? 0) + (event.outputTokens ?? 0));
    const eventId = randomUUID();

    const inserted = await this.db.transaction().execute(async (trx) => {
      const insertedRow = await trx
        .insertInto("usage_events")
        .values({
          id: eventId,
          idempotency_key: event.idempotencyKey,
          account_id: accountId,
          workspace_id: event.workspaceId,
          agent_id: event.agentId ?? null,
          conversation_id: event.conversationId ?? null,
          message_id: event.messageId ?? null,
          surface: event.surface,
          operation: event.operation,
          provider: event.provider,
          model: event.model,
          input_tokens: event.inputTokens ?? 0,
          output_tokens: event.outputTokens ?? 0,
          reasoning_tokens: event.reasoningTokens ?? null,
          total_tokens: totalTokens,
          input_bytes: event.inputBytes ?? 0,
          output_bytes: event.outputBytes ?? 0,
          vector_count: 0,
          event_kind: "model",
          status: event.status,
          usage_quality: event.usageQuality,
          provider_request_id: event.providerRequestId ?? null,
          error_code: event.errorCode ?? null,
          occurred_at: occurredAt,
        })
        .onConflict((oc) => oc.column("idempotency_key").doNothing())
        .returning("id")
        .executeTakeFirst();

      return Boolean(insertedRow);
    });

    if (inserted && accountId && event.status === "succeeded") {
      await this.upsertDailyRollupBestEffort(accountId, occurredAt, {
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
  }

  private async upsertDailyRollupBestEffort(
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
    try {
      await this.upsertDailyRollup(accountId, occurredAt, deltas);
    } catch (error) {
      this.logger?.warn(
        {
          accountId,
          usageDate: toIsoDate(occurredAt),
          operation: deltas.operation,
          provider: deltas.provider,
          model: deltas.model,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to update usage daily rollup after recording usage event",
      );
    }
  }

  private async upsertDailyRollup(
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
    await this.db
      .insertInto("usage_daily_rollups")
      .values({
        account_id: accountId,
        usage_date: toIsoDate(occurredAt),
        operation: deltas.operation,
        provider: deltas.provider,
        model: deltas.model,
        input_tokens: deltas.inputTokens,
        output_tokens: deltas.outputTokens,
        total_tokens: deltas.totalTokens,
        input_bytes: deltas.inputBytes,
        output_bytes: deltas.outputBytes,
        vector_count: deltas.vectorCount,
      })
      .onConflict((oc) =>
        oc
          .columns(["account_id", "usage_date", "operation", "provider", "model"])
          .doUpdateSet((eb) => ({
            input_tokens: eb("usage_daily_rollups.input_tokens", "+", eb.ref("excluded.input_tokens")),
            output_tokens: eb("usage_daily_rollups.output_tokens", "+", eb.ref("excluded.output_tokens")),
            total_tokens: eb("usage_daily_rollups.total_tokens", "+", eb.ref("excluded.total_tokens")),
            input_bytes: eb("usage_daily_rollups.input_bytes", "+", eb.ref("excluded.input_bytes")),
            output_bytes: eb("usage_daily_rollups.output_bytes", "+", eb.ref("excluded.output_bytes")),
            vector_count: eb("usage_daily_rollups.vector_count", "+", eb.ref("excluded.vector_count")),
          })),
      )
      .execute();
  }
}
