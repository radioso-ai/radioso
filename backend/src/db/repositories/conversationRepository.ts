import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  sourceChannel: string | null;
  anonymousSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepositoryPort {
  create(workspaceId: string, sourceChannel?: string | null, anonymousSessionId?: string | null): Promise<ConversationRecord>;
  listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
  findByIdAndAnonymousSession(
    conversationId: string,
    workspaceId: string,
    anonymousSessionId: string,
  ): Promise<ConversationRecord | null>;
  touch(conversationId: string, workspaceId: string): Promise<void>;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  source_channel: string | null;
  anonymous_session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const mapConversation = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  sourceChannel: row.source_channel,
  anonymousSessionId: row.anonymous_session_id ?? null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(workspaceId: string, sourceChannel: string | null = null, anonymousSessionId: string | null = null): Promise<ConversationRecord> {
    const [row] = await this.database.query<ConversationRow>(
      `INSERT INTO conversations (id, workspace_id, source_channel, anonymous_session_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at`,
      [randomUUID(), workspaceId, sourceChannel, anonymousSessionId],
    );

    return mapConversation(row);
  }

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM conversations
           WHERE workspace_id = $1`,
          [workspaceId],
        ))[0]?.count ?? "0");
    const params: Array<string | number> = [workspaceId];
    let cursorClause = "";

    if (cursor) {
      params.push(cursor.keys.updatedAt, cursor.keys.createdAt, cursor.keys.id);
      cursorClause = `
         AND (
           updated_at < $2::timestamptz
           OR (
             updated_at = $2::timestamptz
             AND (
               created_at < $3::timestamptz
               OR (created_at = $3::timestamptz AND id < $4::uuid)
             )
           )
         )`;
    }

    const limitParam = params.length + 1;
    params.push(input.limit + 1);

    let offsetClause = "";
    if (!cursor) {
      offsetClause = `OFFSET $${params.length + 1}`;
      params.push(input.offset ?? 0);
    }

    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1
       ${cursorClause}
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT $${limitParam}
       ${offsetClause}`,
      params,
    );

    const conversations = rows.slice(0, input.limit).map(mapConversation);
    const hasMore = rows.length > input.limit;
    const lastConversation = conversations.at(-1);

    return {
      conversations,
      total,
      nextCursor: hasMore && lastConversation
        ? encodeCursor({
            updatedAt: lastConversation.updatedAt.toISOString(),
            createdAt: lastConversation.createdAt.toISOString(),
            id: lastConversation.id,
          }, total)
        : null,
      hasMore,
    };
  }

  async findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null> {
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND workspace_id = $2`,
      [conversationId, workspaceId],
    );

    return row ? mapConversation(row) : null;
  }

  async listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM conversations
           WHERE workspace_id = $1 AND anonymous_session_id = $2`,
          [workspaceId, anonymousSessionId],
        ))[0]?.count ?? "0");
    const params: Array<string | number> = [workspaceId, anonymousSessionId];
    let cursorClause = "";

    if (cursor) {
      params.push(cursor.keys.updatedAt, cursor.keys.createdAt, cursor.keys.id);
      cursorClause = `
         AND (
           updated_at < $3::timestamptz
           OR (
             updated_at = $3::timestamptz
             AND (
               created_at < $4::timestamptz
               OR (created_at = $4::timestamptz AND id < $5::uuid)
             )
           )
         )`;
    }

    const limitParam = params.length + 1;
    params.push(input.limit + 1);

    let offsetClause = "";
    if (!cursor) {
      offsetClause = `OFFSET $${params.length + 1}`;
      params.push(input.offset ?? 0);
    }

    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1 AND anonymous_session_id = $2
       ${cursorClause}
       ORDER BY updated_at DESC, created_at DESC, id DESC
       LIMIT $${limitParam}
       ${offsetClause}`,
      params,
    );

    const conversations = rows.slice(0, input.limit).map(mapConversation);
    const hasMore = rows.length > input.limit;
    const lastConversation = conversations.at(-1);

    return {
      conversations,
      total,
      nextCursor: hasMore && lastConversation
        ? encodeCursor({
            updatedAt: lastConversation.updatedAt.toISOString(),
            createdAt: lastConversation.createdAt.toISOString(),
            id: lastConversation.id,
          }, total)
        : null,
      hasMore,
    };
  }

  async findByIdAndAnonymousSession(
    conversationId: string,
    workspaceId: string,
    anonymousSessionId: string,
  ): Promise<ConversationRecord | null> {
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND workspace_id = $2 AND anonymous_session_id = $3`,
      [conversationId, workspaceId, anonymousSessionId],
    );

    return row ? mapConversation(row) : null;
  }

  async touch(conversationId: string, workspaceId: string): Promise<void> {
    await this.database.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = $1
         AND workspace_id = $2`,
      [conversationId, workspaceId],
    );
  }
}
