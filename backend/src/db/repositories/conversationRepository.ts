import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

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
  listByWorkspaceId(workspaceId: string): Promise<ConversationRecord[]>;
  listByAnonymousSession(workspaceId: string, anonymousSessionId: string): Promise<ConversationRecord[]>;
  listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset: number },
  ): Promise<{ conversations: ConversationRecord[]; total: number }>;
  listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset: number },
  ): Promise<{ conversations: ConversationRecord[]; total: number }>;
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
  findByIdAndAnonymousSession(conversationId: string, anonymousSessionId: string): Promise<ConversationRecord | null>;
  touch(conversationId: string): Promise<void>;
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

  async listByWorkspaceId(workspaceId: string): Promise<ConversationRecord[]> {
    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1
       ORDER BY updated_at DESC, created_at DESC`,
      [workspaceId],
    );

    return rows.map(mapConversation);
  }

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset: number },
  ): Promise<{ conversations: ConversationRecord[]; total: number }> {
    const [countRow] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM conversations
       WHERE workspace_id = $1`,
      [workspaceId],
    );

    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $2
       OFFSET $3`,
      [workspaceId, input.limit, input.offset],
    );

    return {
      conversations: rows.map(mapConversation),
      total: Number(countRow?.count ?? "0"),
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

  async listByAnonymousSession(workspaceId: string, anonymousSessionId: string): Promise<ConversationRecord[]> {
    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1 AND anonymous_session_id = $2
       ORDER BY updated_at DESC, created_at DESC`,
      [workspaceId, anonymousSessionId],
    );

    return rows.map(mapConversation);
  }

  async listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset: number },
  ): Promise<{ conversations: ConversationRecord[]; total: number }> {
    const [countRow] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM conversations
       WHERE workspace_id = $1 AND anonymous_session_id = $2`,
      [workspaceId, anonymousSessionId],
    );

    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1 AND anonymous_session_id = $2
       ORDER BY updated_at DESC, created_at DESC
       LIMIT $3
       OFFSET $4`,
      [workspaceId, anonymousSessionId, input.limit, input.offset],
    );

    return {
      conversations: rows.map(mapConversation),
      total: Number(countRow?.count ?? "0"),
    };
  }

  async findByIdAndAnonymousSession(conversationId: string, anonymousSessionId: string): Promise<ConversationRecord | null> {
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, source_channel, anonymous_session_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND anonymous_session_id = $2`,
      [conversationId, anonymousSessionId],
    );

    return row ? mapConversation(row) : null;
  }

  async touch(conversationId: string): Promise<void> {
    await this.database.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = $1`,
      [conversationId],
    );
  }
}
