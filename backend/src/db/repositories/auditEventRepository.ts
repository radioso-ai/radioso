import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";

export interface AuditEventRecord {
  id: string;
  accountId: string | null;
  eventType: string;
  eventStatus: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditEventRepositoryPort {
  create(input: {
    accountId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord>;
  listChatAnswerEventsByConversationId(accountId: string, conversationId: string): Promise<AuditEventRecord[]>;
}

interface AuditEventRow {
  id: string;
  account_id: string | null;
  event_type: string;
  event_status: string;
  metadata_json: Record<string, unknown>;
  created_at: Date;
}

const mapAuditEvent = (row: AuditEventRow): AuditEventRecord => ({
  id: row.id,
  accountId: row.account_id,
  eventType: row.event_type,
  eventStatus: row.event_status,
  metadata: row.metadata_json,
  createdAt: new Date(row.created_at),
});

export class AuditEventRepository implements AuditEventRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: {
    accountId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord> {
    const [row] = await this.database.query<AuditEventRow>(
      `INSERT INTO audit_events (id, account_id, event_type, event_status, metadata_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, account_id, event_type, event_status, metadata_json, created_at`,
      [randomUUID(), input.accountId ?? null, input.eventType, input.eventStatus, JSON.stringify(input.metadata ?? {})],
    );

    return mapAuditEvent(row);
  }

  async listChatAnswerEventsByConversationId(accountId: string, conversationId: string): Promise<AuditEventRecord[]> {
    const rows = await this.database.query<AuditEventRow>(
      `SELECT id, account_id, event_type, event_status, metadata_json, created_at
       FROM audit_events
       WHERE account_id = $1
         AND event_type = 'chat.answer'
         AND metadata_json ->> 'conversationId' = $2
       ORDER BY created_at ASC`,
      [accountId, conversationId],
    );

    return rows.map(mapAuditEvent);
  }
}
