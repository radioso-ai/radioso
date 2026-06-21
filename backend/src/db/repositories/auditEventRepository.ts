import { randomUUID } from "node:crypto";

import { anyOf, castText, jsonbKeyText, jsonbSet, toJsonb } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";

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
  listChatAnswerEventsByConversationId(workspaceId: string, conversationId: string): Promise<AuditEventRecord[]>;
  listChatAnswerEventsByAssistantMessageIds(
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
        metadata_json: toJsonb(input.metadata ?? {}),
      })
      .returning(auditEventColumns)
      .executeTakeFirstOrThrow();

    return mapAuditEvent(row as AuditEventRow);
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

  async listChatAnswerEventsByAssistantMessageIds(
    workspaceId: string,
    conversationId: string,
    assistantMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    if (assistantMessageIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom("audit_events")
      .select(auditEventColumns)
      .where("workspace_id", "=", workspaceId)
      .where("event_type", "=", "chat.answer")
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
