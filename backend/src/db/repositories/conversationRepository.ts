import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface ConversationRecord {
  id: string;
  accountId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationRepositoryPort {
  create(accountId: string): Promise<ConversationRecord>;
  listByAccountId(accountId: string): Promise<ConversationRecord[]>;
  findByIdAndAccountId(conversationId: string, accountId: string): Promise<ConversationRecord | null>;
  touch(conversationId: string): Promise<void>;
}

interface ConversationRow {
  id: string;
  account_id: string;
  created_at: Date;
  updated_at: Date;
}

const mapConversation = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  accountId: row.account_id,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export class ConversationRepository implements ConversationRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(accountId: string): Promise<ConversationRecord> {
    const [row] = await this.database.query<ConversationRow>(
      `INSERT INTO conversations (id, account_id)
       VALUES ($1, $2)
       RETURNING id, account_id, created_at, updated_at`,
      [randomUUID(), accountId],
    );

    return mapConversation(row);
  }

  async listByAccountId(accountId: string): Promise<ConversationRecord[]> {
    const rows = await this.database.query<ConversationRow>(
      `SELECT id, account_id, created_at, updated_at
       FROM conversations
       WHERE account_id = $1
       ORDER BY updated_at DESC, created_at DESC`,
      [accountId],
    );

    return rows.map(mapConversation);
  }

  async findByIdAndAccountId(conversationId: string, accountId: string): Promise<ConversationRecord | null> {
    const [row] = await this.database.query<ConversationRow>(
      `SELECT id, account_id, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND account_id = $2`,
      [conversationId, accountId],
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
