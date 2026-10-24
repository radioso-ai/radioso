import { randomUUID } from "node:crypto";

import { anyOf, castText, jsonbKeyText, jsonbSet, toJsonb, toSanitizedJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";
import type { ConversationDataEraser, ConversationErasureScope } from "../../shared/domain/conversationDataErasure.js";
import type { ConversationDataRetentionRule, RetentionAuditRecorder } from "../../shared/domain/conversationDataRetention.js";

export interface AuditEventRecord {
  id: string;
  accountId: string | null;
  workspaceId: string | null;
  eventType: string;
  eventStatus: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventRepositoryPort {
  create(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord>;
  /**
   * Creates the event only if the named conversation still exists, checked and written in one
   * transaction. Returns null, writing nothing, when it does not (a different workspace counts
   * as not existing). See the implementation for why the existence check takes `FOR SHARE`.
   */
  createIfConversationLive(input: {
    accountId?: string | null;
    workspaceId: string;
    conversationId: string;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord | null>;
  listChatAnswerEventsByConversationId(workspaceId: string, conversationId: string): Promise<AuditEventRecord[]>;
  listUnansweredChatAnswerEventsByUserMessageIds(
    workspaceId: string,
    conversationId: string,
    userMessageIds: string[],
  ): Promise<AuditEventRecord[]>;
  listChatTurnEventsByAssistantMessageIds(
    workspaceId: string,
    conversationId: string,
    assistantMessageIds: string[],
  ): Promise<AuditEventRecord[]>;
  findLatestChatAnswerEventByConversationId(
    workspaceId: string,
    conversationId: string,
    status?: "success" | "failure",
  ): Promise<AuditEventRecord | null>;
  updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
  }): Promise<boolean>;
  listDocumentSearchEventPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ events: AuditEventRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  findDocumentSearchEventBySearchId(workspaceId: string, searchId: string): Promise<AuditEventRecord | null>;
}

interface AuditEventRow {
  id: string;
  account_id: string | null;
  workspace_id: string | null;
  event_type: string;
  event_status: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
}

const auditEventColumns = [
  "id",
  "account_id",
  "workspace_id",
  "event_type",
  "event_status",
  "metadata_json",
  "created_at",
] as const;

const mapAuditEvent = (row: AuditEventRow): AuditEventRecord => ({
  id: row.id,
  accountId: row.account_id,
  workspaceId: row.workspace_id,
  eventType: row.event_type,
  eventStatus: row.event_status,
  metadata: row.metadata_json,
  createdAt: new Date(row.created_at),
});

export class AuditEventRepository implements AuditEventRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord> {
    const row = await this.db
      .insertInto("audit_events")
      .values({
        id: randomUUID(),
        account_id: input.accountId ?? null,
        workspace_id: input.workspaceId ?? null,
        event_type: input.eventType,
        event_status: input.eventStatus,
        metadata_json: toSanitizedJsonb(input.metadata ?? {}),
      })
      .returning(auditEventColumns)
      .executeTakeFirstOrThrow();

    return mapAuditEvent(row as AuditEventRow);
  }

  async createIfConversationLive(input: {
    accountId?: string | null;
    workspaceId: string;
    conversationId: string;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord | null> {
    return this.db.transaction().execute(async (trx) => {
      const conversation = await trx
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", input.conversationId)
        .where("workspace_id", "=", input.workspaceId)
        // `FOR SHARE`, not `FOR KEY SHARE`: a live erasure locks this row with `FOR NO KEY
        // UPDATE` (`ConversationRepository.lockForUpdate`), a mode Postgres designs to *not*
        // conflict with `FOR KEY SHARE` — that is what lets a foreign-key check on an unrelated
        // insert proceed without waiting on an ordinary column update. `FOR SHARE` is the
        // row-level mode that *does* conflict with `FOR NO KEY UPDATE`, so this either waits for
        // an in-progress erasure to finish (and then finds the row gone) or, started first,
        // forces a later erasure to wait for this transaction to commit before it locks the row.
        .forShare()
        .executeTakeFirst();
      if (!conversation) {
        return null;
      }
      const row = await trx
        .insertInto("audit_events")
        .values({
          id: randomUUID(),
          account_id: input.accountId ?? null,
          workspace_id: input.workspaceId,
          event_type: input.eventType,
          event_status: input.eventStatus,
          metadata_json: toSanitizedJsonb(input.metadata ?? {}),
        })
        .returning(auditEventColumns)
        .executeTakeFirstOrThrow();
      return mapAuditEvent(row as AuditEventRow);
    });
  }

  async listChatAnswerEventsByConversationId(workspaceId: string, conversationId: string): Promise<AuditEventRecord[]> {
    const rows = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "=", "chat.answer")
      .where((eb) => eb(jsonbKeyText(eb.ref("metadata_json"), "conversationId"), "=", conversationId))
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapAuditEvent(row as AuditEventRow));
  }

  async listUnansweredChatAnswerEventsByUserMessageIds(
    workspaceId: string,
    conversationId: string,
    userMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    if (userMessageIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "=", "chat.answer")
      .where("event_status", "in", ["failure", "cancelled"])
      .where((eb) => eb(jsonbKeyText(eb.ref("metadata_json"), "conversationId"), "=", conversationId))
      .where((eb) => eb(jsonbKeyText(eb.ref("metadata_json"), "assistantMessageId"), "is", null))
      .where((eb) => anyOf(jsonbKeyText(eb.ref("metadata_json"), "userMessageId"), userMessageIds, "text[]"))
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapAuditEvent(row as AuditEventRow));
  }

  async listChatTurnEventsByAssistantMessageIds(
    workspaceId: string,
    conversationId: string,
    assistantMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    if (assistantMessageIds.length === 0) {
      return [];
    }

    // Both completed (`chat.answer`) and suspended (`chat.suspended`, HITL/durable-async
    // turns awaiting an action or approval) carry the turn-trace envelope the debug panel
    // renders. Reading only `chat.answer` hid the panel for action-required turns.
    const rows = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "in", ["chat.answer", "chat.suspended"])
      .where((eb) => eb(jsonbKeyText(eb.ref("metadata_json"), "conversationId"), "=", conversationId))
      .where((eb) => anyOf(jsonbKeyText(eb.ref("metadata_json"), "assistantMessageId"), assistantMessageIds, "text[]"))
      .orderBy("created_at", "asc")
      .execute();

    return rows.map((row) => mapAuditEvent(row as AuditEventRow));
  }

  async findLatestChatAnswerEventByConversationId(
    workspaceId: string,
    conversationId: string,
    status?: "success" | "failure",
  ): Promise<AuditEventRecord | null> {
    const row = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "=", "chat.answer")
      .where((eb) => eb(jsonbKeyText(eb.ref("metadata_json"), "conversationId"), "=", conversationId))
      .$if(status !== undefined, (qb) => qb.where("event_status", "=", status!))
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapAuditEvent(row as AuditEventRow) : null;
  }

  async updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
  }): Promise<boolean> {
    const rows = await this.db
      .updateTable("audit_events")
      .set((eb) => ({
        metadata_json: jsonbSet(eb.ref("metadata_json"), ["suggestions"], toJsonb(input.suggestions)),
      }))
      .where("id", "=", (eb) =>
        eb
          .selectFrom("audit_events")
          .select("id")
          .where("workspace_id", "=", input.workspaceId)
          .where("event_type", "=", "chat.answer")
          .where("event_status", "=", "success")
          .where(eb(jsonbKeyText(eb.ref("metadata_json"), "conversationId"), "=", input.conversationId))
          .where(eb(jsonbKeyText(eb.ref("metadata_json"), "assistantMessageId"), "=", input.assistantMessageId))
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(1),
      )
      .returning("id")
      .execute();

    return rows.length > 0;
  }

  async listDocumentSearchEventPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ events: AuditEventRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.db
          .selectFrom("audit_events")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("workspace_id", "=", workspaceId)
          .where("event_type", "=", "document.search")
          .executeTakeFirst())?.count ?? "0");

    const cursorCreatedAt = cursor ? new Date(cursor.keys.createdAt) : null;
    const rows = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "=", "document.search")
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

    const events = rows.slice(0, input.limit).map((row) => mapAuditEvent(row as AuditEventRow));
    const hasMore = rows.length > input.limit;
    const lastEvent = events.at(-1);

    return {
      events,
      total,
      nextCursor: hasMore && lastEvent
        ? encodeCursor({
            createdAt: lastEvent.createdAt.toISOString(),
            id: lastEvent.id,
          }, total)
        : null,
      hasMore,
    };
  }

  async findDocumentSearchEventBySearchId(workspaceId: string, searchId: string): Promise<AuditEventRecord | null> {
    const row = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "=", "document.search")
      .where((eb) =>
        eb.or([
          eb(jsonbKeyText(eb.ref("metadata_json"), "searchId"), "=", searchId),
          eb(castText(eb.ref("id")), "=", searchId),
        ]),
      )
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();

    return row ? mapAuditEvent(row as AuditEventRow) : null;
  }
}

/**
 * The audit events that hold a turn's conversation-derived content: suggestions, rewritten queries,
 * retrieval diagnostics and turn traces, keyed by the conversation id in their metadata. Every other
 * event that names a conversation records ids and outcome codes only, and stays as the record of
 * what happened.
 */
const CONVERSATION_CONTENT_EVENT_TYPES = ["chat.answer", "chat.suspended"] as const;

/**
 * Erases a conversation's turn events. `audit_events.workspace_id` is SET NULL on workspace
 * deletion, so the workspace scope runs before that cascade, or the events would outlive it.
 */
export class ConversationAuditEraser implements ConversationDataEraser {
  readonly owner = "audit";

  constructor(private readonly db: Db) {}

  async erase(scope: ConversationErasureScope): Promise<number> {
    if (scope.kind === "conversations" && scope.conversationIds.length === 0) {
      return 0;
    }
    let erased = 0;
    // One statement per event type, so each can use its own partial index.
    for (const eventType of CONVERSATION_CONTENT_EVENT_TYPES) {
      const result = await this.db
        .deleteFrom("audit_events")
        .where("workspace_id", "=", scope.workspaceId)
        .where("event_type", "=", eventType)
        .$if(scope.kind === "conversations", (qb) => qb.where((eb) => anyOf(
          jsonbKeyText(eb.ref("metadata_json"), "conversationId"),
          scope.kind === "conversations" ? scope.conversationIds : [],
          "text[]",
        )))
        .executeTakeFirst();
      erased += Number(result.numDeletedRows);
    }
    return erased;
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How long an audit or security event is kept, named rather than configurable: the window is the
 * compliance commitment in `legal/privacy-policy.md`, not a setting a workspace tunes, so no
 * workspace can lengthen or shorten it for its own events.
 */
export const AUDIT_EVENT_RETENTION_DAYS = 365;

/** The instant `AUDIT_EVENT_RETENTION_DAYS` before `now`; an event older than this has passed its window. */
export const auditEventRetentionCutoff = (now: Date): Date => new Date(now.getTime() - AUDIT_EVENT_RETENTION_DAYS * DAY_MS);

/**
 * Sweeps audit events past {@link AUDIT_EVENT_RETENTION_DAYS}, by age alone: an event a deleted
 * workspace left behind (`workspace_id` set NULL by that deletion, migration 007) is swept by the
 * same window rather than going with the workspace, since it is itself part of that deletion's own
 * record. The one event this writes per run that removed anything is content-free: a count and the
 * window, no id of what it removed. Writing goes through the injected audit recorder, the same port
 * every other retention sweep in this codebase uses (`TtlRetentionWorker`, `CopilotRetentionWorker`),
 * rather than inserting a row directly, so this event gets the same `audit_event` log line as every
 * other one.
 */
export class AuditEventRetention implements ConversationDataRetentionRule {
  readonly table = "audit_events";

  constructor(private readonly db: Db, private readonly audit: RetentionAuditRecorder) {}

  async enforce(input: { now: Date; limit: number }): Promise<number> {
    const cutoff = auditEventRetentionCutoff(input.now);
    const deleted = await this.db
      .deleteFrom("audit_events")
      .where("id", "in", (eb) => eb
        .selectFrom("audit_events")
        .select("id")
        .where("created_at", "<", cutoff)
        .limit(input.limit)
        .forUpdate()
        .skipLocked())
      .executeTakeFirst();
    return Number(deleted.numDeletedRows);
  }

  async onRunComplete(input: { now: Date; totalRemoved: number; complete: boolean }): Promise<void> {
    if (input.totalRemoved === 0) return;
    await this.audit.record({
      accountId: null,
      workspaceId: null,
      eventType: "audit_event.retention.enforced",
      eventStatus: "success",
      metadata: {
        deleted: input.totalRemoved,
        retentionDays: AUDIT_EVENT_RETENTION_DAYS,
        cutoff: auditEventRetentionCutoff(input.now).toISOString(),
        // The schedule acting on its own: stated rather than left absent, so a reader of the
        // audit trail can tell this from an event that lost its attribution.
        principalType: "system",
      },
    });
  }
}
