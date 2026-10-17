import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { MessageSource } from "@radioso/conversation-contract";

import {
  replyInterruptionSchema,
  type ReplyInterruption,
  type ReplyInterruptionMarker,
} from "../../modules/chat/contracts/interruption.js";
import {
  operatorReplySpeechSchema,
  type OperatorReplySpeech,
  type OperatorReplySpeechMarker,
  type PendingOperatorReply,
  type PendingOperatorReplyReader,
} from "../../modules/chat/contracts/operatorReplySpeech.js";
import { HUMAN_AUTHORED_MESSAGE_SOURCES, isHumanAuthoredMessageSource } from "../../shared/domain/messageAuthorship.js";
import { clockTimestamp, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
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
  /** Visitor-perceived time from request receipt through the final assistant answer, in milliseconds. */
  totalLatencyMs?: number;
  grounding?: GroundingDiagnosticSnapshot;
  /** On an assistant reply the caller spoke over: how much of it they heard. */
  interruption?: ReplyInterruption;
  /** On a teammate's reply to a caller: whether the call has spoken it yet. */
  speech?: OperatorReplySpeech;
  createdAt: Date;
}

export type UserMessageInputMethod = "typed" | "suggestion_click" | "intent_click" | "routine_invocation";

export interface UserMessageInputMetadata {
  method: UserMessageInputMethod;
  suggestionSourceMessageId?: string;
  intent?: {
    skillName: string;
    intentName?: string;
  };
  /** The structured form of a calling agent's tool call (`method: "routine_invocation"`). */
  routine?: {
    toolName: string;
    input: Record<string, unknown>;
  };
}

const USER_MESSAGE_INPUT_METHODS: ReadonlySet<string> = new Set<UserMessageInputMethod>([
  "typed",
  "suggestion_click",
  "intent_click",
  "routine_invocation",
]);

export interface ConversationMessageSummary {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string | null;
}

export interface TailReadInput {
  sinceCreatedAt?: Date;
  sinceId?: string;
  /** The `markedAt` key of the tail cursor: when the newest marker it delivered was recorded. */
  sinceMarkedAt?: string;
  limit: number;
  redeliverMarkedReplies?: boolean;
}

export interface MessageRepositoryPort {
  findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<MessageRecord | null>;
  listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]>;
  /**
   * The newest `limit` messages, oldest first. `roles` filters before the limit, so a filtered-out
   * row never takes a place in the window.
   */
  listRecentByConversationId(
    workspaceId: string,
    conversationId: string,
    limit: number,
    options?: { roles?: readonly MessageRole[] },
  ): Promise<MessageRecord[]>;
  /**
   * The newest `limit` messages recorded before the conversation's message `beforeMessageId` in
   * `(created_at, id)` order, oldest first. The boundary is that message's own `(created_at, id)`,
   * read by id at the store's full timestamp precision, and applies before the limit, so messages
   * recorded after it never take a place. A boundary that is not a message of the conversation has
   * nothing before it.
   */
  listBeforeByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { beforeMessageId: string; limit: number },
  ): Promise<MessageRecord[]>;
  countByConversationId(workspaceId: string, conversationId: string): Promise<number>;
  listWindowByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  /**
   * The messages after the `(sinceCreatedAt, sinceId)` cursor, oldest first. With
   * `redeliverMarkedReplies`, the read also returns, in the same order, the conversation's
   * assistant replies at or before the cursor whose marker (an interruption, or a teammate's reply
   * spoken to the caller) was recorded since the cursor's message (and after `sinceMarkedAt`, the
   * newest marker the cursor already delivered);
   * the returned cursor carries that newest marker as `markedAt`, so each marker arrives once.
   */
  listSinceByConversationId(
    workspaceId: string,
    conversationId: string,
    input: TailReadInput,
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
    operatorUserId?: string;
    operatorDisplayName?: string;
    /** A teammate's reply the conversation's caller hears on their next turn: stored as pending speech. */
    pendingSpeech?: boolean;
    inputMetadata?: UserMessageInputMetadata;
    metadata?: Record<string, unknown>;
    skillName?: string;
    skillOutcome?: string;
    skillStatus?: string;
    totalLatencyMs?: number;
    grounding?: GroundingDiagnosticSnapshot;
  }): Promise<MessageRecord>;
  /**
   * Deletes one user message of the conversation, for a turn whose input a newer request replaced
   * before it answered. Rows that reference the message follow their foreign keys: usage events
   * keep the spend with the link cleared; coverage assessments, facets and facet jobs go with it.
   * Resolves false when the conversation has no user message with that id.
   */
  deleteUserMessage(input: { workspaceId: string; conversationId: string; messageId: string }): Promise<boolean>;
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

  const candidate = value as { method?: unknown; suggestionSourceMessageId?: unknown; intent?: unknown; routine?: unknown };
  if (typeof candidate.method !== "string" || !USER_MESSAGE_INPUT_METHODS.has(candidate.method)) {
    return undefined;
  }
  const intent = candidate.intent && typeof candidate.intent === "object" && !Array.isArray(candidate.intent)
    ? candidate.intent as { skillName?: unknown; intentName?: unknown }
    : null;
  const routine = candidate.routine && typeof candidate.routine === "object" && !Array.isArray(candidate.routine)
    ? candidate.routine as { toolName?: unknown; input?: unknown }
    : null;

  return {
    method: candidate.method as UserMessageInputMethod,
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
    routine: typeof routine?.toolName === "string" && routine.toolName.length > 0
      ? {
          toolName: routine.toolName,
          input: routine.input && typeof routine.input === "object" && !Array.isArray(routine.input)
            ? routine.input as Record<string, unknown>
            : {},
        }
      : undefined,
  };
};

/** The marker {@link MessageRepository.markReplyInterrupted} keeps in the metadata; a malformed one reads as none. */
const mapInterruption = (metadata: unknown): ReplyInterruption | undefined => {
  const marker = metadata && typeof metadata === "object" ? (metadata as { interruption?: unknown }).interruption : undefined;
  const parsed = replyInterruptionSchema.safeParse(marker);
  return parsed.success ? parsed.data : undefined;
};

/** A teammate reply's speech state; a malformed one, or a spoken one with no time, reads as none. */
const mapSpeech = (metadata: unknown): OperatorReplySpeech | undefined => {
  const marker = metadata && typeof metadata === "object" ? (metadata as { speech?: unknown }).speech : undefined;
  const parsed = operatorReplySpeechSchema.safeParse(marker);
  if (!parsed.success) return undefined;
  return parsed.data.state === "spoken"
    ? (parsed.data.spokenAt ? { state: "spoken", spokenAt: parsed.data.spokenAt } : undefined)
    : { state: "pending" };
};

/**
 * When a marker was recorded, as a UTC ISO string with milliseconds: the format `Date.toISOString`
 * writes, so marker times and tail cursor times compare as text, in time order, without a cast.
 */
const markerRecordedAt = sql<string>`to_char(${clockTimestamp()} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/**
 * The newest marker a reply carries: its interruption's or, on a teammate's reply, when the caller
 * heard it. Null for a reply that carries neither; `GREATEST` skips the one that is missing.
 */
const markerRecordedAtOf = sql<string>`GREATEST(metadata_json -> 'interruption' ->> 'recordedAt', metadata_json -> 'speech' ->> 'spokenAt')`;
const carriesInterruption = sql<boolean>`jsonb_typeof(metadata_json -> 'interruption') = 'object'`;
const awaitsSpeech = sql<boolean>`metadata_json -> 'speech' ->> 'state' = 'pending'`;
const PENDING_SPEECH = { state: "pending" } as const satisfies OperatorReplySpeech;

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
  interruption: row.role === "assistant" ? mapInterruption(row.metadata_json) : undefined,
  speech: row.role === "assistant" && isHumanAuthoredMessageSource(row.source) ? mapSpeech(row.metadata_json) : undefined,
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

const PREVIEW_MAX_LENGTH = 140;

/** Collapses whitespace and truncates to the conversation-list preview length. */
const toPreview = (content: string): string => {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_MAX_LENGTH
    ? `${normalized.slice(0, PREVIEW_MAX_LENGTH - 3)}...`
    : normalized;
};

export class MessageRepository
  implements MessageRepositoryPort, ReplyInterruptionMarker, PendingOperatorReplyReader, OperatorReplySpeechMarker {
  constructor(private readonly db: Db) {}

  async findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<MessageRecord | null> {
    const row = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("id", "=", messageId)
      .executeTakeFirst();
    return row ? mapMessageRow(row as MessageRow) : null;
  }

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

  async listRecentByConversationId(
    workspaceId: string,
    conversationId: string,
    limit: number,
    options: { roles?: readonly MessageRole[] } = {},
  ): Promise<MessageRecord[]> {
    const { roles } = options;
    if (limit <= 0 || roles?.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .$if(roles !== undefined, (qb) => qb.where("role", "in", [...(roles ?? [])]))
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    return rows.map((row) => mapMessageRow(row as MessageRow)).reverse();
  }

  async listBeforeByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { beforeMessageId: string; limit: number },
  ): Promise<MessageRecord[]> {
    if (input.limit <= 0) {
      return [];
    }

    // The boundary is resolved in Postgres: `created_at` carries microseconds (`clock_timestamp()`),
    // and a JavaScript Date round trip would truncate them, dropping a predecessor recorded within the
    // boundary's millisecond. No such message makes the row comparison null, so nothing matches.
    const rows = await this.db
      .selectFrom("messages")
      .select(messageColumns)
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .where(sql<boolean>`(created_at, id) < (
        SELECT boundary.created_at, boundary.id
          FROM messages boundary
         WHERE boundary.id = ${input.beforeMessageId}
           AND boundary.workspace_id = ${workspaceId}
           AND boundary.conversation_id = ${conversationId}
      )`)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit)
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
    input: TailReadInput,
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
    const cursorMessage = messages.at(-1) ?? latest;
    const redelivered = input.redeliverMarkedReplies
      ? await this.listMarkedSince(workspaceId, conversationId, {
          sinceCreatedAt,
          sinceId,
          sinceMarkedAt: input.sinceMarkedAt,
          limit: input.limit,
        })
      : { messages: [], newestMarkedAt: undefined };
    const markedAt = [input.sinceMarkedAt, redelivered.newestMarkedAt]
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);

    return {
      messages: [...redelivered.messages, ...messages],
      latestCursor: cursorMessage
        ? encodeCursor({
            createdAt: cursorMessage.createdAt.toISOString(),
            id: cursorMessage.id,
            // Only a marker recorded since the cursor's message still needs the watermark.
            ...(markedAt !== undefined && markedAt >= cursorMessage.createdAt.toISOString() ? { markedAt } : {}),
          })
        : newestCursor,
    };
  }

  /**
   * Assistant replies at or before the cursor whose marker was recorded at or after the cursor's
   * message and after the newest marker already delivered, oldest first. Marker times and cursor
   * times share one text format, so they compare as text.
   */
  private async listMarkedSince(
    workspaceId: string,
    conversationId: string,
    input: { sinceCreatedAt: Date; sinceId: string; sinceMarkedAt?: string; limit: number },
  ): Promise<{ messages: MessageRecord[]; newestMarkedAt: string | undefined }> {
    const rows = await this.db
      .selectFrom("messages")
      .select([...messageColumns, markerRecordedAtOf.as("marked_at")])
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .where("role", "=", "assistant")
      .where((eb) =>
        eb.or([
          eb("created_at", "<", input.sinceCreatedAt),
          eb.and([eb("created_at", "=", input.sinceCreatedAt), eb("id", "<=", input.sinceId)]),
        ]),
      )
      // A reply that carries no marker has a null time, which no comparison passes.
      .where(markerRecordedAtOf, ">=", input.sinceCreatedAt.toISOString())
      .$if(input.sinceMarkedAt !== undefined, (query) => query.where(markerRecordedAtOf, ">", input.sinceMarkedAt!))
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();
    return {
      messages: rows.map((row) => mapMessageRow(row as MessageRow)),
      newestMarkedAt: rows.map((row) => row.marked_at).sort().at(-1),
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

    const firstUserMessageRows = await this.db
      .selectFrom("messages")
      .select(["conversation_id", "content"])
      .distinctOn("conversation_id")
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "in", conversationIds)
      .where("role", "=", "user")
      // Skip whitespace-only user messages so a blank first turn doesn't overwrite the
      // newest-message fallback below with an empty preview; DISTINCT ON then naturally
      // lands on the earliest *non-blank* user message, or none at all.
      .where(sql<boolean>`btrim(content) <> ''`)
      .orderBy("conversation_id")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();

    const newestMessageRows = await this.db
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
      newestMessageRows.map((row) => [row.conversation_id, toPreview(row.content)]),
    );
    for (const row of firstUserMessageRows) {
      previewByConversationId.set(row.conversation_id, toPreview(row.content));
    }

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
    operatorUserId?: string;
    operatorDisplayName?: string;
    pendingSpeech?: boolean;
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
      ...(input.operatorAccountId || input.operatorUserId || input.operatorDisplayName
        ? {
            humanAgent: {
              accountId: input.operatorAccountId,
              userId: input.operatorUserId,
              displayName: input.operatorDisplayName,
            },
          }
        : {}),
      ...(input.pendingSpeech ? { speech: PENDING_SPEECH } : {}),
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

  /**
   * Keeps the marker under `metadata_json.interruption` with the time it was recorded, merged into
   * the reply's other metadata. A reply that already carries a marker keeps it whole: the first
   * report wins, so a retried note never moves its counts or its `recordedAt`.
   */
  async markReplyInterrupted(input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
  } & ReplyInterruption): Promise<boolean> {
    const counts = { heardCharacterCount: input.heardCharacterCount, spokenCharacterCount: input.spokenCharacterCount };
    const marker = jsonbConcat(toJsonb(counts), sql`jsonb_build_object('recordedAt', ${markerRecordedAt})`);
    // A reply that already carries a marker is matched and rewritten unchanged, so a retried note
    // still learns that the reply is marked and goes on to its audit event.
    const result = await this.db
      .updateTable("messages")
      .set((eb) => ({
        metadata_json: sql`CASE WHEN ${carriesInterruption} THEN metadata_json
          ELSE ${jsonbConcat(eb.ref("metadata_json"), sql`jsonb_build_object('interruption', ${marker})`)} END`,
      }))
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("id", "=", input.messageId)
      .where("role", "=", "assistant")
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Teammate replies still marked pending speech, oldest first, on the conversation's own messages. */
  async pendingOperatorReplies(input: { workspaceId: string; conversationId: string }): Promise<PendingOperatorReply[]> {
    const rows = await this.db
      .selectFrom("messages")
      .select(["id", "content", "created_at"])
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("role", "=", "assistant")
      .where("source", "in", [...HUMAN_AUTHORED_MESSAGE_SOURCES])
      .where(awaitsSpeech)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => ({ messageId: row.id, text: row.content, createdAt: new Date(row.created_at) }));
  }

  /**
   * Replaces a pending reply's `speech` with `{ state: "spoken", spokenAt }`, the time on the
   * database clock in the tail cursor's format, so the dashboard tail re-delivers the reply once.
   * Only pending replies match, so a reply spoken already keeps its first `spokenAt`.
   */
  async markOperatorRepliesSpoken(input: { workspaceId: string; conversationId: string; messageIds: string[] }): Promise<string[]> {
    if (input.messageIds.length === 0) return [];
    const spoken = sql`jsonb_build_object('state', 'spoken', 'spokenAt', ${markerRecordedAt})`;
    const rows = await this.db
      .updateTable("messages")
      .set((eb) => ({ metadata_json: jsonbConcat(eb.ref("metadata_json"), sql`jsonb_build_object('speech', ${spoken})`) }))
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("id", "in", input.messageIds)
      .where("role", "=", "assistant")
      .where(awaitsSpeech)
      .returning("id")
      .execute();
    return rows.map((row) => row.id);
  }

  async deleteUserMessage(input: { workspaceId: string; conversationId: string; messageId: string }): Promise<boolean> {
    const result = await this.db
      .deleteFrom("messages")
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("id", "=", input.messageId)
      .where("role", "=", "user")
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
