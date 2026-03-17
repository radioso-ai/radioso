import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface MessageRecord {
  id: string;
  conversationId: string;
  workspaceId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}

export interface MessageRepositoryPort {
  listByConversationId(conversationId: string): Promise<MessageRecord[]>;
  create(input: {
    conversationId: string;
    workspaceId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }): Promise<MessageRecord>;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: Date;
}

const mapMessage = (row: MessageRow): MessageRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  workspaceId: row.workspace_id,
  role: row.role,
  content: row.content,
  createdAt: new Date(row.created_at),
});

export class MessageRepository implements MessageRepositoryPort {
  constructor(private readonly database: Database) {}

  async listByConversationId(conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.database.query<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId],
    );

    return rows.map(mapMessage);
  }

  async create(input: {
    conversationId: string;
    workspaceId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }): Promise<MessageRecord> {
    const [row] = await this.database.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, workspace_id, role, content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, conversation_id, workspace_id, role, content, created_at`,
      [randomUUID(), input.conversationId, input.workspaceId, input.role, input.content],
    );

    return mapMessage(row);
  }
}
