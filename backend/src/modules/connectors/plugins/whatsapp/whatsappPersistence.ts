import { randomUUID } from "node:crypto";

import type { ConnectorDatabasePort } from "../../domain/connectorPlugin.js";

export interface WhatsAppContactRecord {
  id: string;
  waId: string;
  profileName: string | null;
  workspaceId: string;
  conversationId: string;
  firstSeenAt: Date;
  lastMessageAt: Date;
}

export interface WhatsAppMessageLogRecord {
  id: string;
  wamid: string;
  direction: "inbound" | "outbound";
  workspaceId: string;
  waId: string;
  messageType: string;
  payload: Record<string, unknown>;
  status: "received" | "processing" | "replied" | "failed";
  errorDetails: string | null;
  createdAt: Date;
}

export interface WhatsAppPersistencePort {
  findContact(workspaceId: string, waId: string): Promise<WhatsAppContactRecord | null>;
  upsertContact(input: {
    workspaceId: string;
    waId: string;
    profileName: string | null;
    conversationId: string;
    lastMessageAt: Date;
  }): Promise<WhatsAppContactRecord>;
  findMessageLogByWamid(wamid: string): Promise<WhatsAppMessageLogRecord | null>;
  createMessageLog(input: {
    wamid: string;
    direction: "inbound" | "outbound";
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
    status: "received" | "processing" | "replied" | "failed";
    errorDetails?: string | null;
  }): Promise<WhatsAppMessageLogRecord>;
  updateMessageLogStatus(
    wamid: string,
    status: "received" | "processing" | "replied" | "failed",
    errorDetails?: string | null,
  ): Promise<void>;
  nextLocalOutboundWamid(): string;
}

interface WhatsAppContactRow {
  id: string;
  wa_id: string;
  profile_name: string | null;
  workspace_id: string;
  conversation_id: string;
  first_seen_at: Date;
  last_message_at: Date;
}

interface WhatsAppMessageLogRow {
  id: string;
  wamid: string;
  direction: "inbound" | "outbound";
  workspace_id: string;
  wa_id: string;
  message_type: string;
  payload: Record<string, unknown>;
  status: "received" | "processing" | "replied" | "failed";
  error_details: string | null;
  created_at: Date;
}

const mapContact = (row: WhatsAppContactRow): WhatsAppContactRecord => ({
  id: row.id,
  waId: row.wa_id,
  profileName: row.profile_name,
  workspaceId: row.workspace_id,
  conversationId: row.conversation_id,
  firstSeenAt: new Date(row.first_seen_at),
  lastMessageAt: new Date(row.last_message_at),
});

const mapMessageLog = (row: WhatsAppMessageLogRow): WhatsAppMessageLogRecord => ({
  id: row.id,
  wamid: row.wamid,
  direction: row.direction,
  workspaceId: row.workspace_id,
  waId: row.wa_id,
  messageType: row.message_type,
  payload: row.payload,
  status: row.status,
  errorDetails: row.error_details,
  createdAt: new Date(row.created_at),
});

export class PostgresWhatsAppPersistence implements WhatsAppPersistencePort {
  constructor(private readonly db: ConnectorDatabasePort) {}

  async findContact(workspaceId: string, waId: string): Promise<WhatsAppContactRecord | null> {
    const [row] = await this.db.query<WhatsAppContactRow>(
      `SELECT id, wa_id, profile_name, workspace_id, conversation_id, first_seen_at, last_message_at
       FROM connector_whatsapp_contacts
       WHERE workspace_id = $1 AND wa_id = $2`,
      [workspaceId, waId],
    );

    return row ? mapContact(row) : null;
  }

  async upsertContact(input: {
    workspaceId: string;
    waId: string;
    profileName: string | null;
    conversationId: string;
    lastMessageAt: Date;
  }): Promise<WhatsAppContactRecord> {
    const [row] = await this.db.query<WhatsAppContactRow>(
      `INSERT INTO connector_whatsapp_contacts (
         id, wa_id, profile_name, workspace_id, conversation_id, last_message_at
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, wa_id)
       DO UPDATE SET
         profile_name = EXCLUDED.profile_name,
         conversation_id = EXCLUDED.conversation_id,
         last_message_at = EXCLUDED.last_message_at
       RETURNING id, wa_id, profile_name, workspace_id, conversation_id, first_seen_at, last_message_at`,
      [
        randomUUID(),
        input.waId,
        input.profileName,
        input.workspaceId,
        input.conversationId,
        input.lastMessageAt,
      ],
    );

    return mapContact(row);
  }

  async findMessageLogByWamid(wamid: string): Promise<WhatsAppMessageLogRecord | null> {
    const [row] = await this.db.query<WhatsAppMessageLogRow>(
      `SELECT id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details, created_at
       FROM connector_whatsapp_message_log
       WHERE wamid = $1`,
      [wamid],
    );

    return row ? mapMessageLog(row) : null;
  }

  async createMessageLog(input: {
    wamid: string;
    direction: "inbound" | "outbound";
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
    status: "received" | "processing" | "replied" | "failed";
    errorDetails?: string | null;
  }): Promise<WhatsAppMessageLogRecord> {
    const [row] = await this.db.query<WhatsAppMessageLogRow>(
      `INSERT INTO connector_whatsapp_message_log (
         id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details, created_at`,
      [
        randomUUID(),
        input.wamid,
        input.direction,
        input.workspaceId,
        input.waId,
        input.messageType,
        JSON.stringify(input.payload),
        input.status,
        input.errorDetails ?? null,
      ],
    );

    return mapMessageLog(row);
  }

  async updateMessageLogStatus(
    wamid: string,
    status: "received" | "processing" | "replied" | "failed",
    errorDetails?: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE connector_whatsapp_message_log
       SET status = $2, error_details = $3
       WHERE wamid = $1`,
      [wamid, status, errorDetails ?? null],
    );
  }

  nextLocalOutboundWamid(): string {
    return `local-${randomUUID()}`;
  }
}
