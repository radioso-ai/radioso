import { randomUUID } from "node:crypto";

import type { MessageSource } from "@radioso/conversation-contract";

import { clockTimestamp, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import type { GroundingDiagnosticSnapshot } from "../../shared/domain/groundingDiagnostic.js";

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
  /** Turn wall time in milliseconds. Assistant turns only; absent when the turn produced no measurement. */
  totalLatencyMs?: number;
  grounding?: GroundingDiagnosticSnapshot;
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
  countByConversationId(workspaceId: string, conversationId: string): Promise<number>;
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
    totalLatencyMs?: number;
    grounding?: GroundingDiagnosticSnapshot;
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
  total_latency_ms: number | null;
  grounding_verdict: GroundingDiagnosticSnapshot["verdict"] | null;
  grounding_claim_count: number | null;
  grounding_sourced_claim_count: number | null;
  grounding_unsourced_claim_count: number | null;
  grounding_invalid_source_count: number | null;
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

const messageColumns = [
  "id",
  "conversation_id",
  "workspace_id",
  "role",
  "content",
  "source",
  "metadata_json",
  "skill_name",
  "skill_outcome",
  "skill_status",
  "total_latency_ms",
  "grounding_verdict",
  "grounding_claim_count",
  "grounding_sourced_claim_count",
  "grounding_unsourced_claim_count",
  "grounding_invalid_source_count",
  "created_at",
] as const;

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
  totalLatencyMs: row.total_latency_ms ?? undefined,
  grounding: row.grounding_verdict === null
    ? undefined
    : {
        verdict: row.grounding_verdict,
        claimCount: row.grounding_claim_count!,
        sourcedClaimCount: row.grounding_sourced_claim_count!,
        unsourcedClaimCount: row.grounding_unsourced_claim_count!,
        invalidSourceCount: row.grounding_invalid_source_count!,
      },
  createdAt: new Date(row.created_at),
});

export class MessageRepository implements MessageRepositoryPort {
  constructor(private readonly db: Db) {}

  async listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    return rows.map((row) => mapMessageRow(row as MessageRow));
  }

  async listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map((row) => mapMessageRow(row as MessageRow)).reverse();
  }

  async countByConversationId(workspaceId: string, conversationId: string): Promise<number> {
    const row = await this.db
      .selectFrom("messages")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .executeTakeFirst();
    return Number(row?.count ?? "0");
  }

  async listWindowByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.db
          .selectFrom("messages")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("conversation_id", "=", conversationId)
          .executeTakeFirst())?.count ?? "0");

    const cursorCreatedAt = cursor ? new Date(cursor.keys.createdAt) : null;
    const rows = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .$if(Boolean(cursor), (qb) =>
        qb.where((eb) =>
          eb.or([
            eb("created_at", "<", cursorCreatedAt!),
            eb.and([eb("created_at", "=", cursorCreatedAt!), eb("id", "<", cursor!.keys.id)]),
          ]),
        ),
      )
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit + 1)
      .$if(!cursor, (qb) => qb.offset(input.offset ?? 0))
      .execute();

    const latestFirst = rows.slice(0, input.limit).map((row) => mapMessageRow(row as MessageRow));
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
    const latestRow = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const latest = latestRow ? mapMessageRow(latestRow as MessageRow) : null;
    const newestCursor = latest
      ? encodeCursor({
          createdAt: latest.createdAt.toISOString(),
          id: latest.id,
        })
      : null;

    if (!input.sinceCreatedAt || !input.sinceId) {
      const rows = await this.db
        .selectFrom("messages")
        .select(messageColumns)
        .where("workspace_id", "=", workspaceId)
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(input.limit)
        .execute();
      const messages = rows.map((row) => mapMessageRow(row as MessageRow)).reverse();
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

    const sinceCreatedAt = input.sinceCreatedAt;
    const sinceId = input.sinceId;
    const rows = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .where((eb) =>
        eb.or([
          eb("created_at", ">", sinceCreatedAt),
          eb.and([eb("created_at", "=", sinceCreatedAt), eb("id", ">", sinceId)]),
        ]),
      )
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();

    const messages = rows.map((row) => mapMessageRow(row as MessageRow));
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

    const countRows = await this.db
      .selectFrom("messages")
      .select((eb) => [
        "conversation_id",
        eb.fn.countAll<string>().as("message_count"),
        eb.fn.countAll<string>().filterWhere("role", "=", "user").as("user_message_count"),
        eb.fn.countAll<string>().filterWhere("role", "=", "assistant").as("assistant_message_count"),
      ])
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "in", conversationIds)
      .groupBy("conversation_id")
      .execute();

    const previewRows = await this.db
      .selectFrom("messages")
      .select(["conversation_id", "content"])
      .distinctOn("conversation_id")
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "in", conversationIds)
      .orderBy("conversation_id")
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();

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

  /**
   * Narrow read used by facet extraction: the content of one message, or `null` when
   * it no longer exists (deleted conversation, workspace mismatch). Not part of
   * {@link MessageRepositoryPort} — that interface is a much larger surface than a
   * per-message background job should depend on; this satisfies the facets module's
   * own `FacetSourceMessagePort` structurally.
   */
  async getContentById(input: { workspaceId: string; messageId: string }): Promise<string | null> {
    const row = await this.db
      .selectFrom("messages")
      .select("content")
      .where("workspace_id", "=", input.workspaceId)
      .where("id", "=", input.messageId)
      .executeTakeFirst();
    return row?.content ?? null;
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
    totalLatencyMs?: number;
    grounding?: GroundingDiagnosticSnapshot;
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
    const row = await this.db
      .insertInto("messages")
      .values({
        id: input.id ?? randomUUID(),
        conversation_id: input.conversationId,
        workspace_id: input.workspaceId,
        role: input.role,
        content: input.content,
        source: input.source ?? deriveMessageSourceFromRole(input.role),
        metadata_json: toJsonb(metadata),
        skill_name: input.skillName ?? null,
        skill_outcome: input.skillOutcome ?? null,
        skill_status: input.skillStatus ?? null,
        total_latency_ms: input.totalLatencyMs ?? null,
        grounding_verdict: input.grounding?.verdict ?? null,
        grounding_claim_count: input.grounding?.claimCount ?? null,
        grounding_sourced_claim_count: input.grounding?.sourcedClaimCount ?? null,
        grounding_unsourced_claim_count: input.grounding?.unsourcedClaimCount ?? null,
        grounding_invalid_source_count: input.grounding?.invalidSourceCount ?? null,
        created_at: clockTimestamp(),
      })
      .returning(messageColumns)
      .executeTakeFirstOrThrow();

    return mapMessageRow(row as MessageRow);
  }
}
