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

export interface ConversationMessageSummary {
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  preview: string | null;
}

export interface MessageRepositoryPort {
  listByConversationId(conversationId: string): Promise<MessageRecord[]>;
  listWindowByConversationId(
    conversationId: string,
    input: { limit: number; offset: number },
  ): Promise<{ messages: MessageRecord[]; total: number }>;
  summarizeByConversationIds(conversationIds: string[]): Promise<Map<string, ConversationMessageSummary>>;
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

  async listWindowByConversationId(
    conversationId: string,
    input: { limit: number; offset: number },
  ): Promise<{ messages: MessageRecord[]; total: number }> {
    const [countRow] = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM messages
       WHERE conversation_id = $1`,
      [conversationId],
    );

    const rows = await this.database.query<MessageRow>(
      `SELECT id, conversation_id, workspace_id, role, content, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
       OFFSET $3`,
      [conversationId, input.limit, input.offset],
    );

    return {
      messages: rows.map(mapMessage).reverse(),
      total: Number(countRow?.count ?? "0"),
    };
  }

  async summarizeByConversationIds(conversationIds: string[]): Promise<Map<string, ConversationMessageSummary>> {
    const summaries = new Map<string, ConversationMessageSummary>();
    if (conversationIds.length === 0) {
      return summaries;
    }

    const countRows = await this.database.query<{
      conversation_id: string;
      message_count: string;
      user_message_count: string;
      assistant_message_count: string;
    }>(
      `SELECT conversation_id,
              COUNT(*)::text AS message_count,
              COUNT(*) FILTER (WHERE role = 'user')::text AS user_message_count,
              COUNT(*) FILTER (WHERE role = 'assistant')::text AS assistant_message_count
       FROM messages
       WHERE conversation_id = ANY($1::uuid[])
       GROUP BY conversation_id`,
      [conversationIds],
    );

    const previewRows = await this.database.query<{ conversation_id: string; content: string }>(
      `SELECT DISTINCT ON (conversation_id) conversation_id, content
       FROM messages
       WHERE conversation_id = ANY($1::uuid[])
       ORDER BY conversation_id, created_at DESC, id DESC`,
      [conversationIds],
    );

    const previewByConversationId = new Map(
      previewRows.map((row) => {
        const normalized = row.content.replace(/\s+/g, " ").trim();
        const preview = normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
        return [row.conversation_id, preview];
      }),
    );

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
