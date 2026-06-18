import { randomUUID } from "node:crypto";

import type { MessageSource } from "@radioso/conversation-contract";

import type { Database } from "../../shared/infra/database.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageRecord {
  id: string;
  conversationId: string;
  workspaceId: string;
  role: MessageRole;
  content: string;
  source?: MessageSource;
  metadata?: Record<string, unknown>;
  inputMetadata?: UserMessageInputMetadata;
  skillName?: string;
  skillOutcome?: string;
  skillStatus?: string;
  createdAt: Date;
}

export type UserMessageInputMethod = "typed" | "suggestion_click" | "intent_click";

export interface UserMessageInputMetadata {
  method: UserMessageInputMethod;
  suggestionSourceMessageId?: string;
  intent?: {
    skillName: string;
    intentName?: string;
  };
}

export interface ConversationMessageSummary {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string | null;
}

export interface MessageRepositoryPort {
  listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]>;
  listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
  listWindowByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  listSinceByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { sinceCreatedAt?: Date; sinceId?: string; limit: number },
  ): Promise<{ messages: MessageRecord[]; latestCursor: string | null }>;
  summarizeByConversationIds(
    workspaceId: string,
    conversationIds: string[],
  ): Promise<Map<string, ConversationMessageSummary>>;
  create(input: {
    id?: string;
    conversationId: string;
    workspaceId: string;
    role: MessageRole;
    content: string;
    source?: MessageSource;
    operatorAccountId?: string;
    operatorDisplayName?: string;
    inputMetadata?: UserMessageInputMetadata;
    metadata?: Record<string, unknown>;
    skillName?: string;
    skillOutcome?: string;
    skillStatus?: string;
  }): Promise<MessageRecord>;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: MessageRole;
  content: string;
  source: MessageSource | null;
  metadata_json: unknown;
  skill_name: string | null;
  skill_outcome: string | null;
  skill_status: string | null;
  created_at: Date;
}

export const deriveMessageSourceFromRole = (role: MessageRole): MessageSource => {
  switch (role) {
    case "user":
      return "customer";
    case "assistant":
      return "ai_agent";
    case "system":
      return "system";
  }
};

const mapInputMetadata = (value: unknown): UserMessageInputMetadata | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as { method?: unknown; suggestionSourceMessageId?: unknown; intent?: unknown };
  if (candidate.method !== "typed" && candidate.method !== "suggestion_click" && candidate.method !== "intent_click") {
    return undefined;
  }
  const intent = candidate.intent && typeof candidate.intent === "object" && !Array.isArray(candidate.intent)
    ? candidate.intent as { skillName?: unknown; intentName?: unknown }
    : null;

  return {
    method: candidate.method,
    suggestionSourceMessageId:
      typeof candidate.suggestionSourceMessageId === "string" && candidate.suggestionSourceMessageId.length > 0
        ? candidate.suggestionSourceMessageId
        : undefined,
    intent: typeof intent?.skillName === "string" && intent.skillName.length > 0
      ? {
          skillName: intent.skillName,
          intentName: typeof intent.intentName === "string" && intent.intentName.length > 0 ? intent.intentName : undefined,
        }
      : undefined,
  };
};

export const mapMessageRow = (row: MessageRow): MessageRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  role: row.role,
  content: row.content,
  source: row.source ?? deriveMessageSourceFromRole(row.role),
  metadata: row.metadata_json && typeof row.metadata_json === "object" && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : undefined,
  inputMetadata: row.role === "user" ? mapInputMetadata(row.metadata_json) : undefined,
  skillName: row.skill_name ?? undefined,
  skillOutcome: row.skill_outcome ?? undefined,
  skillStatus: row.skill_status ?? undefined,
  createdAt: new Date(row.created_at),
});

export class MessageRepository implements MessageRepositoryPort {
  constructor(private readonly database: Database) {}

  async listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.database.query<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = $2
       ORDER BY created_at ASC, id ASC`,
      [workspaceId, conversationId],
    );

    return rows.map(mapMessageRow);
  }

  async listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const rows = await this.database.query<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [workspaceId, conversationId, limit],
    );

    return rows.map(mapMessageRow).reverse();
  }

  async listWindowByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM messages
           WHERE workspace_id = $1
             AND conversation_id = $2`,
          [workspaceId, conversationId],
        ))[0]?.count ?? "0");
    const params: Array<string | number> = [workspaceId, conversationId];
    let cursorClause = "";

    if (cursor) {
      params.push(cursor.keys.createdAt, cursor.keys.id);
      cursorClause = `
         AND (
           created_at < $3::timestamptz
           OR (created_at = $3::timestamptz AND id < $4::uuid)
         )`;
    }

    const limitParam = params.length + 1;
    params.push(input.limit + 1);

    let offsetClause = "";
    if (!cursor) {
      offsetClause = `OFFSET $${params.length + 1}`;
      params.push(input.offset ?? 0);
    }

    const rows = await this.database.query<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = $2
       ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParam}
       ${offsetClause}`,
      params,
    );

    const latestFirst = rows.slice(0, input.limit).map(mapMessageRow);
    const hasMore = rows.length > input.limit;
    const oldestFetched = latestFirst.at(-1);

    return {
      messages: latestFirst.reverse(),
      total,
      nextCursor: hasMore && oldestFetched
        ? encodeCursor({
            createdAt: oldestFetched.createdAt.toISOString(),
            id: oldestFetched.id,
          }, total)
        : null,
      hasMore,
    };
  }

  async listSinceByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { sinceCreatedAt?: Date; sinceId?: string; limit: number },
  ): Promise<{ messages: MessageRecord[]; latestCursor: string | null }> {
    // Tail cursor is (created_at, id). Safe because messages within a conversation are inserted
    // one-per-operation via clock_timestamp() and are causally sequential, so created_at is unique
    // per conversation and the strict (created_at,id) comparison never skips a row. INVARIANT: do
    // not batch-insert multiple messages to one conversation in a single statement/microsecond
    // without switching the cursor to a monotonic sequence.
    const latestRow = await this.database.queryOptional<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [workspaceId, conversationId],
    );
    const latest = latestRow ? mapMessageRow(latestRow) : null;
    const newestCursor = latest
      ? encodeCursor({
          createdAt: latest.createdAt.toISOString(),
          id: latest.id,
        })
      : null;

    if (!input.sinceCreatedAt || !input.sinceId) {
      return { messages: [], latestCursor: newestCursor };
    }

    const rows = await this.database.query<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = $2
         AND (
           created_at > $3::timestamptz
           OR (created_at = $3::timestamptz AND id > $4::uuid)
         )
       ORDER BY created_at ASC, id ASC
       LIMIT $5`,
      [workspaceId, conversationId, input.sinceCreatedAt.toISOString(), input.sinceId, input.limit],
    );

    const messages = rows.map(mapMessageRow);
    const lastReturned = messages.at(-1);

    return {
      messages,
      latestCursor: lastReturned
        ? encodeCursor({
            createdAt: lastReturned.createdAt.toISOString(),
            id: lastReturned.id,
          })
        : newestCursor,
    };
  }

  async summarizeByConversationIds(
    workspaceId: string,
    conversationIds: string[],
  ): Promise<Map<string, ConversationMessageSummary>> {
    const summaries = new Map<string, ConversationMessageSummary>();
    if (conversationIds.length === 0) {
      return summaries;
    }

    const countRows = await this.database.query<{
      conversation_id: string;
      message_count: string;
      user_message_count: string;
      assistant_message_count: string;
    }>(
      `SELECT conversation_id,
              COUNT(*)::text AS message_count,
              COUNT(*) FILTER (WHERE role = 'user')::text AS user_message_count,
              COUNT(*) FILTER (WHERE role = 'assistant')::text AS assistant_message_count
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = ANY($2::uuid[])
       GROUP BY conversation_id`,
      [workspaceId, conversationIds],
    );

    const previewRows = await this.database.query<{ conversation_id: string; content: string }>(
      `SELECT DISTINCT ON (conversation_id) conversation_id, content
       FROM messages
       WHERE workspace_id = $1
         AND conversation_id = ANY($2::uuid[])
       ORDER BY conversation_id, created_at DESC, id DESC`,
      [workspaceId, conversationIds],
    );

    const previewByConversationId = new Map(
      previewRows.map((row) => {
        const normalized = row.content.replace(/\s+/g, " ").trim();
        const preview = normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
        return [row.conversation_id, preview];
      }),
    );

    for (const row of countRows) {
      summaries.set(row.conversation_id, {
        messageCount: Number(row.message_count),
        userMessageCount: Number(row.user_message_count),
        assistantMessageCount: Number(row.assistant_message_count),
        preview: previewByConversationId.get(row.conversation_id) ?? null,
      });
    }

    return summaries;
  }

  async create(input: {
    id?: string;
    conversationId: string;
    workspaceId: string;
    role: MessageRole;
    content: string;
    source?: MessageSource;
    operatorAccountId?: string;
    operatorDisplayName?: string;
    inputMetadata?: UserMessageInputMetadata;
    metadata?: Record<string, unknown>;
    skillName?: string;
    skillOutcome?: string;
    skillStatus?: string;
  }): Promise<MessageRecord> {
    const metadata = {
      ...(input.metadata ?? input.inputMetadata ?? {}),
      ...(input.operatorAccountId || input.operatorDisplayName
        ? {
            humanAgent: {
              accountId: input.operatorAccountId,
              displayName: input.operatorDisplayName,
            },
          }
        : {}),
    };
    const [row] = await this.database.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, clock_timestamp())
       RETURNING id, conversation_id, workspace_id, role, content, source, metadata_json, skill_name, skill_outcome, skill_status, created_at`,
      [
        input.id ?? randomUUID(),
        input.conversationId,
        input.workspaceId,
        input.role,
        input.content,
        input.source ?? deriveMessageSourceFromRole(input.role),
        JSON.stringify(metadata),
        input.skillName ?? null,
        input.skillOutcome ?? null,
        input.skillStatus ?? null,
      ],
    );

    return mapMessageRow(row);
  }
}
