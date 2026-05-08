import { randomUUID } from "node:crypto";
import type { MessageRecord } from "./messageRepository.js";

import type { Database } from "../../shared/infra/database.js";
import { decodeCursorWithKeys, encodeCursor } from "../../shared/domain/cursorPagination.js";

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  agentId: string | null;
  sourceChannel: string | null;
  sourceOrigin: string | null;
  anonymousSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepositoryPort {
  create(
    workspaceId: string,
    agentId?: string | null,
    sourceChannel?: string | null,
    anonymousSessionId?: string | null,
    sourceOrigin?: string | null,
  ): Promise<ConversationRecord>;
  createWithInitialAssistantMessage(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    content: string;
  }): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }>;
  listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  countByWorkspaceId(workspaceId: string): Promise<number>;
  listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }>;
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
  findByIdAndAnonymousSession(
    conversationId: string,
    workspaceId: string,
    anonymousSessionId: string,
    agentId?: string | null,
  ): Promise<ConversationRecord | null>;
  touch(conversationId: string, workspaceId: string): Promise<void>;
}

interface ConversationRow {
  // SQL rows keep database column names; repository records are the camelCase boundary type.
  id: string;
  workspace_id: string;
  agent_id: string | null;
  source_channel: string | null;
  source_origin: string | null;
  anonymous_session_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: Date;
}

const mapConversation = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  agentId: row.agent_id ?? null,
  sourceChannel: row.source_channel,
  sourceOrigin: row.source_origin ?? null,
  anonymousSessionId: row.anonymous_session_id ?? null,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(
    workspaceId: string,
    agentId: string | null = null,
    sourceChannel: string | null = null,
    anonymousSessionId: string | null = null,
    sourceOrigin: string | null = null,
  ): Promise<ConversationRecord> {
    const [row] = await this.database.query<ConversationRow>(
      `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id, created_at, updated_at`,
      [randomUUID(), workspaceId, agentId, sourceChannel, sourceOrigin, anonymousSessionId],
    );

    return mapConversation(row);
  }

  async createWithInitialAssistantMessage(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    content: string;
  }): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }> {
    return this.database.withTransaction(async (client) => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const conversationResult = await client.query<ConversationRow>(
        `INSERT INTO conversations (id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id, created_at, updated_at`,
        [conversationId, input.workspaceId, input.agentId ?? null, input.sourceChannel ?? null, input.sourceOrigin ?? null, input.anonymousSessionId ?? null],
      );
      const messageResult = await client.query<MessageRow>(
        `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
         VALUES ($1, $2, $3, 'assistant', $4)
         RETURNING id, conversation_id, workspace_id, role, content, created_at`,
        [messageId, conversationId, input.workspaceId, input.content],
      );

      return {
        conversation: mapConversation(conversationResult.rows[0]),
        assistantMessage: {
          id: messageResult.rows[0].id,
          conversationId: messageResult.rows[0].conversation_id,
          workspaceId: messageResult.rows[0].workspace_id,
          role: messageResult.rows[0].role,
          content: messageResult.rows[0].content,
          createdAt: new Date(messageResult.rows[0].created_at),
        },
      };
    });
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
      `SELECT id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id, created_at, updated_at
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

  async countByWorkspaceId(workspaceId: string): Promise<number> {
    const [row] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM conversations
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    return Number(row?.count ?? "0");
  }

  async findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null> {
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND workspace_id = $2`,
      [conversationId, workspaceId],
    );

    return row ? mapConversation(row) : null;
  }

  async listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const params: Array<string | number> = [workspaceId, anonymousSessionId];
    const agentClause = input.agentId
      ? ` AND agent_id = $${params.push(input.agentId)}`
      : "";
    const total = cursor?.totalSnapshot !== undefined
      ? Number(cursor.totalSnapshot)
      : Number((await this.database.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM conversations
           WHERE workspace_id = $1 AND anonymous_session_id = $2${agentClause}`,
          params,
        ))[0]?.count ?? "0");
    let cursorClause = "";

    if (cursor) {
      const updatedAtParam = params.push(cursor.keys.updatedAt);
      const createdAtParam = params.push(cursor.keys.createdAt);
      const idParam = params.push(cursor.keys.id);
      cursorClause = `
         AND (
           updated_at < $${updatedAtParam}::timestamptz
           OR (
             updated_at = $${updatedAtParam}::timestamptz
             AND (
               created_at < $${createdAtParam}::timestamptz
               OR (created_at = $${createdAtParam}::timestamptz AND id < $${idParam}::uuid)
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
      `SELECT id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1 AND anonymous_session_id = $2${agentClause}
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
    agentId?: string | null,
  ): Promise<ConversationRecord | null> {
    const params = [conversationId, workspaceId, anonymousSessionId];
    const agentClause = agentId ? ` AND agent_id = $${params.push(agentId)}` : "";
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, agent_id, source_channel, source_origin, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND workspace_id = $2 AND anonymous_session_id = $3${agentClause}`,
      params,
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
