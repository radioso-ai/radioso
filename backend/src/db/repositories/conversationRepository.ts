import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface ConversationRecord {
  id: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepositoryPort {
  create(workspaceId: string): Promise<ConversationRecord>;
  listByWorkspaceId(workspaceId: string): Promise<ConversationRecord[]>;
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
  touch(conversationId: string): Promise<void>;
}

interface ConversationRow {
  id: string;
  workspace_id: string;
  created_at: Date;
  updated_at: Date;
}

const mapConversation = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(workspaceId: string): Promise<ConversationRecord> {
    const [row] = await this.database.query<ConversationRow>(
      `INSERT INTO conversations (id, workspace_id)
       VALUES ($1, $2)
       RETURNING id, workspace_id, created_at, updated_at`,
      [randomUUID(), workspaceId],
    );

    return mapConversation(row);
  }

  async listByWorkspaceId(workspaceId: string): Promise<ConversationRecord[]> {
    const rows = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, created_at, updated_at
       FROM conversations
       WHERE workspace_id = $1
       ORDER BY updated_at DESC, created_at DESC`,
      [workspaceId],
    );

    return rows.map(mapConversation);
  }

  async findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null> {
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, workspace_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND workspace_id = $2`,
      [conversationId, workspaceId],
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
