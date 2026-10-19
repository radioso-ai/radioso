import { randomUUID } from "node:crypto";

import { sql, type RawBuilder } from "kysely";
import { z } from "zod";

import type { MessageSource } from "@radioso/conversation-contract";

import {
  replyInterruptionSchema,
  type ReplyInterruption,
  type ReplyInterruptionMarker,
} from "../../modules/chat/contracts/interruption.js";
import type {
  OperatorReplyClaim,
  OperatorReplySpeech,
  OperatorReplySpeechClaims,
  PendingOperatorReply,
} from "../../modules/chat/contracts/operatorReplySpeech.js";
import { VOICE_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";
import { HUMAN_AUTHORED_MESSAGE_SOURCES, isHumanAuthoredMessageSource } from "../../shared/domain/messageAuthorship.js";
import { clockTimestamp, clockTimestampMinusSeconds, jsonbConcat, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
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
  /** The tail cursor's `createdAt` text, verbatim — see {@link MessageRepositoryPort.listSinceByConversationId}. */
  sinceCreatedAt?: string;
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
   * The messages after the `(sinceCreatedAt, sinceId)` cursor, oldest first. `sinceCreatedAt` is
   * the cursor's `createdAt` text verbatim — full microsecond precision when the cursor was cut
   * from this repository, millisecond precision for an older cursor — compared against the
   * `created_at` column at that same precision; never convert it to a JS `Date` first, which
   * would round it down to milliseconds and let the newest row in a page match its own cursor
   * again on the next poll. With `redeliverMarkedReplies`, the read also returns, in the same
   * order, the conversation's assistant replies at or before the cursor whose marker (an
   * interruption, or a teammate's reply spoken to the caller) was recorded since the cursor's
   * message (and after `sinceMarkedAt`, the newest marker the cursor already delivered); the
   * returned cursor carries that newest marker as `markedAt`, so each marker arrives once.
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
    /**
     * A reply stored already cut short, such as the heard part of one cut off mid-stream: its
     * marker, kept where a later mark keeps one, so no later mark changes it.
     */
    interruption?: ReplyInterruption;
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

/** What a stored message is created from. */
export type MessageCreateInput = Parameters<MessageRepositoryPort["create"]>[0];

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

/**
 * The marker as the metadata keeps it: `partial` only on a reply stored as its heard part, which
 * carries its marker from the start; a mark written later carries `recordedAt`.
 */
const storedInterruptionSchema = replyInterruptionSchema.extend({ partial: z.boolean().optional() });

const storedInterruption = (interruption: ReplyInterruption): z.infer<typeof storedInterruptionSchema> => ({
  heardCharacterCount: interruption.heardCharacterCount,
  spokenCharacterCount: interruption.spokenCharacterCount,
  ...(interruption.partial ? { partial: true as const } : {}),
});

/** The marker {@link MessageRepository.markReplyInterrupted} or `create` keeps in the metadata; a malformed one reads as none. */
const mapInterruption = (metadata: unknown): ReplyInterruption | undefined => {
  const marker = metadata && typeof metadata === "object" ? (metadata as { interruption?: unknown }).interruption : undefined;
  const parsed = storedInterruptionSchema.safeParse(marker);
  return parsed.success
    ? { heardCharacterCount: parsed.data.heardCharacterCount, spokenCharacterCount: parsed.data.spokenCharacterCount, partial: parsed.data.partial === true }
    : undefined;
};

/**
 * How a teammate reply's speech is stored: `pending`; `claimed` by the turn speaking it, with when;
 * `spoken`, with when that turn completed; `skipped`, with when, for a reply with no words to say.
 */
const storedSpeechSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }),
  z.object({ state: z.literal("claimed"), claimedAt: z.string(), claimTurnId: z.string() }),
  z.object({ state: z.literal("spoken"), spokenAt: z.string().datetime() }),
  z.object({ state: z.literal("skipped"), skippedAt: z.string() }),
]);

/** A teammate reply's speech as readers see it: a claim is still pending; a malformed state reads as none. */
const mapSpeech = (metadata: unknown): OperatorReplySpeech | undefined => {
  const marker = metadata && typeof metadata === "object" ? (metadata as { speech?: unknown }).speech : undefined;
  const parsed = storedSpeechSchema.safeParse(marker);
  if (!parsed.success) return undefined;
  switch (parsed.data.state) {
    case "pending":
    case "claimed":
      return { state: "pending" };
    case "spoken":
      return { state: "spoken", spokenAt: parsed.data.spokenAt };
    case "skipped":
      return { state: "skipped" };
  }
};

/**
 * A database time as a UTC ISO string with milliseconds: the format `Date.toISOString` writes, so
 * marker times, claim times and the tail cursor's `markedAt` watermark compare as text, in time
 * order, without a cast. Deliberately lossy to stay comparable with `Date`-derived text; for the
 * tail cursor's own `createdAt` key, which must survive a strict re-comparison against the exact
 * row it was cut from, use {@link preciseIsoText} instead.
 */
const isoText = (time: RawBuilder<Date>) => sql<string>`to_char((${time}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/** When a marker is recorded: now, on the database clock. */
const markerRecordedAt = isoText(clockTimestamp());
/**
 * `<expression>` as a UTC ISO string at the database's full microsecond precision, fixed-width so
 * it still sorts as text. A JS `Date` read of a `created_at` column rounds to milliseconds; a tail
 * cursor built from that rounded value is strictly behind the row it came from, so the row matches
 * `created_at > cursor` again on the very next poll (the newest-message re-delivery this format
 * exists to prevent). Decode and compare the resulting text directly against the column — through
 * {@link preciseTimestamptz}, never through `new Date(...)`, which reintroduces the same rounding.
 */
const preciseIsoText = (columnName: string) =>
  sql<string>`to_char(${sql.ref(columnName)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'`;
/** A tail cursor's `createdAt` text, cast back to `timestamptz` at its own precision for a column comparison. */
const preciseTimestamptz = (text: string) => sql<Date>`${text}::timestamptz`;

/**
 * Builds a message tail cursor from a row carrying {@link preciseIsoText}'s `created_at_precise`
 * column, the one place `listSinceByConversationId` encodes one, so every branch (no cursor
 * supplied, a limit-capped page, the empty "nothing newer" case) agrees on its shape.
 */
export const encodeTailCursor = (row: { created_at_precise: string; id: string }, markedAt?: string): string =>
  encodeCursor({
    createdAt: row.created_at_precise,
    id: row.id,
    ...(markedAt !== undefined ? { markedAt } : {}),
  });
/**
 * The newest marker a reply carries: its interruption's or, on a teammate's reply, when it was
 * spoken or skipped. Null for a reply that carries none; `GREATEST` skips the ones missing.
 */
const markerRecordedAtOf = sql<string>`GREATEST(
  metadata_json -> 'interruption' ->> 'recordedAt',
  metadata_json -> 'speech' ->> 'spokenAt',
  metadata_json -> 'speech' ->> 'skippedAt'
)`;
const carriesInterruption = sql<boolean>`jsonb_typeof(metadata_json -> 'interruption') = 'object'`;
const speechState = sql<string>`metadata_json -> 'speech' ->> 'state'`;
/** Pending, or claimed by a turn that never settled it within the expiry. */
const awaitsSpeech = sql<boolean>`(${speechState} = 'pending' OR (${speechState} = 'claimed'
  AND metadata_json -> 'speech' ->> 'claimedAt' < ${isoText(clockTimestampMinusSeconds(VOICE_BEHAVIOR.operatorReplyClaimExpiryMs / 1_000))}))`;
const claimedBy = (claimTurnId: string) =>
  sql<boolean>`(${speechState} = 'claimed' AND metadata_json -> 'speech' ->> 'claimTurnId' = ${claimTurnId})`;
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
  implements MessageRepositoryPort, ReplyInterruptionMarker, OperatorReplySpeechClaims {
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
    // Tail cursor is (created_at, id), `created_at` carried as `preciseIsoText` so the cursor
    // round-trips the database's full microsecond precision rather than the millisecond precision
    // a JS `Date` read of the column would round it to. `id` is a tie-break only for a genuine
    // full-precision tie; messages within a conversation are inserted one-per-operation via
    // clock_timestamp() and are causally sequential, so that tie is not otherwise expected. Do not
    // batch-insert multiple messages to one conversation in a single statement, which could produce
    // one.
    const latestRow = await this.db
      .selectFrom("messages")
      .select([...messageColumns, preciseIsoText("created_at").as("created_at_precise")])
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const newestCursor = latestRow ? encodeTailCursor(latestRow) : null;

    if (!input.sinceCreatedAt || !input.sinceId) {
      const rows = await this.db
        .selectFrom("messages")
        .select([...messageColumns, preciseIsoText("created_at").as("created_at_precise")])
        .where("workspace_id", "=", workspaceId)
        .where("conversation_id", "=", conversationId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(input.limit)
        .execute();
      // DESC order: the first row is the newest, i.e. the one `.reverse()` below puts last.
      const newestRow = rows[0];
      const messages = rows.map((row) => mapMessageRow(row as MessageRow)).reverse();

      return {
        messages,
        latestCursor: newestRow ? encodeTailCursor(newestRow) : newestCursor,
      };
    }

    const sinceCreatedAt = input.sinceCreatedAt;
    const sinceId = input.sinceId;
    const sinceCreatedAtColumn = preciseTimestamptz(sinceCreatedAt);
    const rows = await this.db
      .selectFrom("messages")
      .select([...messageColumns, preciseIsoText("created_at").as("created_at_precise")])
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .where((eb) =>
        eb.or([
          eb("created_at", ">", sinceCreatedAtColumn),
          eb.and([eb("created_at", "=", sinceCreatedAtColumn), eb("id", ">", sinceId)]),
        ]),
      )
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .limit(input.limit)
      .execute();

    const messages = rows.map((row) => mapMessageRow(row as MessageRow));
    const cursorRow = rows.at(-1) ?? latestRow;
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
      latestCursor: cursorRow
        ? encodeTailCursor(
            cursorRow,
            // Only a marker recorded since the cursor's message still needs the watermark.
            markedAt !== undefined && markedAt >= cursorRow.created_at.toISOString() ? markedAt : undefined,
          )
        : newestCursor,
    };
  }

  /**
   * Assistant replies at or before the cursor whose marker was recorded at or after the cursor's
   * message and after the newest marker already delivered, oldest first. The `created_at` boundary
   * compares at the cursor's own precision (see {@link listSinceByConversationId}); the marker
   * boundary compares `markerRecordedAtOf` against the cursor's millisecond-rounded text, because
   * marker times are themselves only ever written at that width.
   */
  private async listMarkedSince(
    workspaceId: string,
    conversationId: string,
    input: { sinceCreatedAt: string; sinceId: string; sinceMarkedAt?: string; limit: number },
  ): Promise<{ messages: MessageRecord[]; newestMarkedAt: string | undefined }> {
    const sinceCreatedAtColumn = preciseTimestamptz(input.sinceCreatedAt);
    const sinceCreatedAtMs = new Date(input.sinceCreatedAt).toISOString();
    const rows = await this.db
      .selectFrom("messages")
      .select([...messageColumns, markerRecordedAtOf.as("marked_at")])
      .where("workspace_id", "=", workspaceId)
      .where("conversation_id", "=", conversationId)
      .where("role", "=", "assistant")
      .where((eb) =>
        eb.or([
          eb("created_at", "<", sinceCreatedAtColumn),
          eb.and([eb("created_at", "=", sinceCreatedAtColumn), eb("id", "<=", input.sinceId)]),
        ]),
      )
      // A reply that carries no marker has a null time, which no comparison passes.
      .where(markerRecordedAtOf, ">=", sinceCreatedAtMs)
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
    interruption?: ReplyInterruption;
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
      ...(input.interruption ? { interruption: storedInterruption(input.interruption) } : {}),
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
  } & Omit<ReplyInterruption, "partial">): Promise<boolean> {
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

  /**
   * One UPDATE claims and reads the conversation's pending teammate replies (or ones held by a
   * claim past its expiry): a row another claim took first fails the condition once its lock is
   * released, so two turns claiming at once never both hold a reply.
   */
  async claimPendingOperatorReplies(input: { workspaceId: string; conversationId: string; claimTurnId: string }): Promise<PendingOperatorReply[]> {
    const claimed = sql`jsonb_build_object('state', 'claimed', 'claimedAt', ${markerRecordedAt}, 'claimTurnId', ${input.claimTurnId}::text)`;
    const rows = await this.teammateReplies(input)
      .set((eb) => ({ metadata_json: jsonbConcat(eb.ref("metadata_json"), sql`jsonb_build_object('speech', ${claimed})`) }))
      .where(awaitsSpeech)
      .returning(["id", "content", "created_at"])
      .execute();
    return rows
      .map((row) => ({ messageId: row.id, text: row.content, createdAt: new Date(row.created_at).getTime() }))
      .sort((left, right) => left.createdAt - right.createdAt || (left.messageId < right.messageId ? -1 : 1))
      .map(({ messageId, text }) => ({ messageId, text }));
  }

  /**
   * `spokenAt` is the database clock in the tail cursor's format, so the dashboard tail re-delivers
   * the reply once. Only replies the turn still holds match, so the first `spokenAt` stays.
   */
  markOperatorRepliesSpoken(input: OperatorReplyClaim): Promise<string[]> {
    return this.settleClaim(input, sql`jsonb_build_object('state', 'spoken', 'spokenAt', ${markerRecordedAt})`);
  }

  skipOperatorReplies(input: OperatorReplyClaim): Promise<string[]> {
    return this.settleClaim(input, sql`jsonb_build_object('state', 'skipped', 'skippedAt', ${markerRecordedAt})`);
  }

  releaseOperatorReplies(input: OperatorReplyClaim): Promise<string[]> {
    return this.settleClaim(input, toJsonb(PENDING_SPEECH));
  }

  /** The conversation's teammate replies, as an UPDATE of them. */
  private teammateReplies(input: { workspaceId: string; conversationId: string }) {
    return this.db
      .updateTable("messages")
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .where("role", "=", "assistant")
      .where("source", "in", [...HUMAN_AUTHORED_MESSAGE_SOURCES]);
  }

  /** Replaces the speech state of those of `messageIds` the turn still holds. */
  private async settleClaim(input: OperatorReplyClaim, next: RawBuilder<unknown>): Promise<string[]> {
    if (input.messageIds.length === 0) return [];
    const rows = await this.teammateReplies(input)
      .set((eb) => ({ metadata_json: jsonbConcat(eb.ref("metadata_json"), sql`jsonb_build_object('speech', ${next})`) }))
      .where("id", "in", input.messageIds)
      .where(claimedBy(input.claimTurnId))
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
