import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface UsageEventRecord {
  id: string;
  operationKey: string;
  accountId: string;
  workspaceId: string | null;
  conversationId: string | null;
  userMessageId: string | null;
  assistantMessageId: string | null;
  documentId: string | null;
  processingJobId: string | null;
  sourceArea: string;
  operationType: string;
  model: string;
  eventStatus: string;
  usageAvailable: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
}

export interface UsageEventInsertInput {
  operationKey: string;
  accountId: string;
  workspaceId?: string | null;
  conversationId?: string | null;
  userMessageId?: string | null;
  assistantMessageId?: string | null;
  documentId?: string | null;
  processingJobId?: string | null;
  sourceArea: string;
  operationType: string;
  model: string;
  eventStatus: string;
  usageAvailable: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  metadata?: Record<string, unknown>;
  occurredAt: Date;
}

export interface UsageEventRepositoryPort {
  record(input: UsageEventInsertInput): Promise<{ inserted: boolean; record: UsageEventRecord | null }>;
  listByAssistantMessageIds(assistantMessageIds: string[]): Promise<UsageEventRecord[]>;
  listByAccountId(accountId: string): Promise<UsageEventRecord[]>;
}

interface UsageEventRow {
  id: string;
  operation_key: string;
  account_id: string;
  workspace_id: string | null;
  conversation_id: string | null;
  user_message_id: string | null;
  assistant_message_id: string | null;
  document_id: string | null;
  processing_job_id: string | null;
  source_area: string;
  operation_type: string;
  model: string;
  event_status: string;
  usage_available: boolean;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  metadata_json: Record<string, unknown>;
  occurred_at: Date;
  created_at: Date;
}

const mapUsageEvent = (row: UsageEventRow): UsageEventRecord => ({
  id: row.id,
  operationKey: row.operation_key,
  accountId: row.account_id,
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  userMessageId: row.user_message_id,
  assistantMessageId: row.assistant_message_id,
  documentId: row.document_id,
  processingJobId: row.processing_job_id,
  sourceArea: row.source_area,
  operationType: row.operation_type,
  model: row.model,
  eventStatus: row.event_status,
  usageAvailable: row.usage_available,
  promptTokens: row.prompt_tokens,
  completionTokens: row.completion_tokens,
  totalTokens: row.total_tokens,
  metadata: row.metadata_json,
  occurredAt: new Date(row.occurred_at),
  createdAt: new Date(row.created_at),
});

export class UsageEventRepository implements UsageEventRepositoryPort {
  constructor(private readonly database: Database) {}

  async record(input: UsageEventInsertInput): Promise<{ inserted: boolean; record: UsageEventRecord | null }> {
    return this.database.withTransaction(async (client) => {
      const inserted = await client.query<UsageEventRow>(
        `INSERT INTO usage_events (
           id, operation_key, account_id, workspace_id, conversation_id, user_message_id,
           assistant_message_id, document_id, processing_job_id, source_area, operation_type,
           model, event_status, usage_available, prompt_tokens, completion_tokens, total_tokens,
           metadata_json, occurred_at
         )
         VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17,
           $18::jsonb, $19
         )
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING id, operation_key, account_id, workspace_id, conversation_id, user_message_id,
                   assistant_message_id, document_id, processing_job_id, source_area, operation_type,
                   model, event_status, usage_available, prompt_tokens, completion_tokens, total_tokens,
                   metadata_json, occurred_at, created_at`,
        [
          randomUUID(),
          input.operationKey,
          input.accountId,
          input.workspaceId ?? null,
          input.conversationId ?? null,
          input.userMessageId ?? null,
          input.assistantMessageId ?? null,
          input.documentId ?? null,
          input.processingJobId ?? null,
          input.sourceArea,
          input.operationType,
          input.model,
          input.eventStatus,
          input.usageAvailable,
          input.promptTokens ?? null,
          input.completionTokens ?? null,
          input.totalTokens ?? null,
          JSON.stringify(input.metadata ?? {}),
          input.occurredAt,
        ],
      );

      const row = inserted.rows[0];
      if (!row) {
        return { inserted: false, record: null };
      }

      await client.query(
        `INSERT INTO account_daily_usage_summaries (
           account_id, usage_date, prompt_tokens, completion_tokens, total_tokens,
           usage_event_count, unavailable_event_count, updated_at
         )
         VALUES (
           $1,
           ($2 AT TIME ZONE 'UTC')::date,
           $3,
           $4,
           $5,
           1,
           $6,
           NOW()
         )
         ON CONFLICT (account_id, usage_date) DO UPDATE
         SET prompt_tokens = account_daily_usage_summaries.prompt_tokens + EXCLUDED.prompt_tokens,
             completion_tokens = account_daily_usage_summaries.completion_tokens + EXCLUDED.completion_tokens,
             total_tokens = account_daily_usage_summaries.total_tokens + EXCLUDED.total_tokens,
             usage_event_count = account_daily_usage_summaries.usage_event_count + 1,
             unavailable_event_count = account_daily_usage_summaries.unavailable_event_count + EXCLUDED.unavailable_event_count,
             updated_at = NOW()`,
        [
          input.accountId,
          input.occurredAt,
          input.promptTokens ?? 0,
          input.completionTokens ?? 0,
          input.totalTokens ?? 0,
          input.usageAvailable ? 0 : 1,
        ],
      );

      return { inserted: true, record: mapUsageEvent(row) };
    });
  }

  async listByAssistantMessageIds(assistantMessageIds: string[]): Promise<UsageEventRecord[]> {
    if (assistantMessageIds.length === 0) {
      return [];
    }

    const rows = await this.database.query<UsageEventRow>(
      `SELECT id, operation_key, account_id, workspace_id, conversation_id, user_message_id,
              assistant_message_id, document_id, processing_job_id, source_area, operation_type,
              model, event_status, usage_available, prompt_tokens, completion_tokens, total_tokens,
              metadata_json, occurred_at, created_at
       FROM usage_events
       WHERE assistant_message_id = ANY($1::uuid[])
       ORDER BY occurred_at ASC, created_at ASC`,
      [assistantMessageIds],
    );

    return rows.map(mapUsageEvent);
  }

  async listByAccountId(accountId: string): Promise<UsageEventRecord[]> {
    const rows = await this.database.query<UsageEventRow>(
      `SELECT id, operation_key, account_id, workspace_id, conversation_id, user_message_id,
              assistant_message_id, document_id, processing_job_id, source_area, operation_type,
              model, event_status, usage_available, prompt_tokens, completion_tokens, total_tokens,
              metadata_json, occurred_at, created_at
       FROM usage_events
       WHERE account_id = $1
       ORDER BY occurred_at ASC, created_at ASC`,
      [accountId],
    );

    return rows.map(mapUsageEvent);
  }
}
