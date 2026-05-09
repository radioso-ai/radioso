import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import { stringifyJsonb } from "../../shared/infra/jsonb.js";
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
    conversationModeMetadata: unknown;
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
  constructor(private readonly database: Database) {}

  async create(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord> {
    const [row] = await this.database.query<AuditEventRow>(
      `INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, account_id, workspace_id, event_type, event_status, metadata_json, created_at`,
      [randomUUID(), input.accountId ?? null, input.workspaceId ?? null, input.eventType, input.eventStatus, stringifyJsonb(input.metadata ?? {})],
    );

    return mapAuditEvent(row);
  }

  async listChatAnswerEventsByConversationId(workspaceId: string, conversationId: string): Promise<AuditEventRecord[]> {
    const rows = await this.database.query<AuditEventRow>(
      `SELECT id, account_id, workspace_id, event_type, event_status, metadata_json, created_at
       FROM audit_events
       WHERE workspace_id = $1
         AND event_type = 'chat.answer'
         AND metadata_json ->> 'conversationId' = $2
       ORDER BY created_at ASC`,
      [workspaceId, conversationId],
    );

    return rows.map(mapAuditEvent);
  }

  async listChatAnswerEventsByAssistantMessageIds(
    workspaceId: string,
    conversationId: string,
    assistantMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    if (assistantMessageIds.length === 0) {
      return [];
    }

    const rows = await this.database.query<AuditEventRow>(
      `SELECT id, account_id, workspace_id, event_type, event_status, metadata_json, created_at
       FROM audit_events
       WHERE workspace_id = $1
         AND event_type = 'chat.answer'
         AND metadata_json ->> 'conversationId' = $2
         AND metadata_json ->> 'assistantMessageId' = ANY($3::text[])
       ORDER BY created_at ASC`,
      [workspaceId, conversationId, assistantMessageIds],
    );

    return rows.map(mapAuditEvent);
  }

  async findLatestChatAnswerEventByConversationId(
    workspaceId: string,
    conversationId: string,
    status?: "success" | "failure",
  ): Promise<AuditEventRecord | null> {
    const params: unknown[] = [workspaceId, conversationId];
    const statusClause = status ? `AND event_status = $3` : "";

    if (status) {
      params.push(status);
    }

    const [row] = await this.database.query<AuditEventRow>(
      `SELECT id, account_id, workspace_id, event_type, event_status, metadata_json, created_at
       FROM audit_events
       WHERE workspace_id = $1
         AND event_type = 'chat.answer'
         AND metadata_json ->> 'conversationId' = $2
         ${statusClause}
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      params,
    );

    return row ? mapAuditEvent(row) : null;
  }

  async updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
    conversationModeMetadata: unknown;
  }): Promise<boolean> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE audit_events
       SET metadata_json = jsonb_set(
         jsonb_set(
           coalesce(metadata_json, '{}'::jsonb),
           '{suggestions}',
           $4::jsonb,
           true
         ),
         '{conversationModeMetadata}',
         $5::jsonb,
         true
       )
       WHERE id = (
         SELECT id
         FROM audit_events
         WHERE workspace_id = $1
           AND event_type = 'chat.answer'
           AND event_status = 'success'
           AND metadata_json ->> 'conversationId' = $2
           AND metadata_json ->> 'assistantMessageId' = $3
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING id`,
      [
        input.workspaceId,
        input.conversationId,
        input.assistantMessageId,
        stringifyJsonb(input.suggestions),
        stringifyJsonb(input.conversationModeMetadata),
      ],
    );

    return result.length > 0;
  }

  async listDocumentSearchEventPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ events: AuditEventRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM audit_events
           WHERE workspace_id = $1
             AND event_type = 'document.search'`,
          [workspaceId],
        ))[0]?.count ?? "0");
    const params: Array<string | number> = [workspaceId];
    let cursorClause = "";

    if (cursor) {
      params.push(cursor.keys.createdAt, cursor.keys.id);
      cursorClause = `
         AND (
           created_at < $2::timestamptz
           OR (created_at = $2::timestamptz AND id < $3::uuid)
         )`;
    }

    const limitParam = params.length + 1;
    params.push(input.limit + 1);

    let offsetClause = "";
    if (!cursor) {
      offsetClause = `OFFSET $${params.length + 1}`;
      params.push(input.offset ?? 0);
    }

    const rows = await this.database.query<AuditEventRow>(
      `SELECT id, account_id, workspace_id, event_type, event_status, metadata_json, created_at
       FROM audit_events
       WHERE workspace_id = $1
         AND event_type = 'document.search'
       ${cursorClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitParam}
       ${offsetClause}`,
      params,
    );

    const events = rows.slice(0, input.limit).map(mapAuditEvent);
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
    const [row] = await this.database.query<AuditEventRow>(
      `SELECT id, account_id, workspace_id, event_type, event_status, metadata_json, created_at
       FROM audit_events
       WHERE workspace_id = $1
         AND event_type = 'document.search'
         AND (metadata_json ->> 'searchId' = $2 OR id::text = $2)
       ORDER BY created_at DESC
       LIMIT 1`,
      [workspaceId, searchId],
    );

    return row ? mapAuditEvent(row) : null;
  }
}
