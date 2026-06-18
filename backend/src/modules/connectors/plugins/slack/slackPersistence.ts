import { randomUUID } from "node:crypto";

import type { ConnectorDatabasePort } from "@radioso/connector-api";

export interface SlackConversationLinkRecord {
  id: string;
  workspaceId: string;
  installationId: string;
  slackKey: string;
  conversationId: string;
}

export interface SlackPersistencePort {
  createInboundEvent(input: { eventId: string; teamId: string }): Promise<boolean>;
  markInboundEventStatus(eventId: string, status: "processed" | "skipped"): Promise<void>;
  findConversationLink(input: { workspaceId: string; slackKey: string }): Promise<SlackConversationLinkRecord | null>;
  upsertConversationLink(input: {
    workspaceId: string;
    installationId: string;
    slackKey: string;
    conversationId: string;
  }): Promise<SlackConversationLinkRecord>;
}

interface SlackConversationLinkRow {
  id: string;
  workspace_id: string;
  installation_id: string;
  slack_key: string;
  conversation_id: string;
}

const mapLink = (row: SlackConversationLinkRow): SlackConversationLinkRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  installationId: row.installation_id,
  slackKey: row.slack_key,
  conversationId: row.conversation_id,
});

export class PostgresSlackPersistence implements SlackPersistencePort {
  constructor(private readonly db: ConnectorDatabasePort) {}

  async createInboundEvent(input: { eventId: string; teamId: string }): Promise<boolean> {
    const rows = await this.db.query<{ event_id: string }>(
      `INSERT INTO slack_inbound_events (event_id, team_id, status)
       VALUES ($1, $2, 'received')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [input.eventId, input.teamId],
    );
    return rows.length > 0;
  }

  async markInboundEventStatus(eventId: string, status: "processed" | "skipped"): Promise<void> {
    await this.db.query(
      `UPDATE slack_inbound_events SET status = $2 WHERE event_id = $1`,
      [eventId, status],
    );
  }

  async findConversationLink(input: {
    workspaceId: string;
    slackKey: string;
  }): Promise<SlackConversationLinkRecord | null> {
    const [row] = await this.db.query<SlackConversationLinkRow>(
      `SELECT id, workspace_id, installation_id, slack_key, conversation_id
       FROM slack_conversation_links
       WHERE workspace_id = $1 AND slack_key = $2`,
      [input.workspaceId, input.slackKey],
    );
    return row ? mapLink(row) : null;
  }

  async upsertConversationLink(input: {
    workspaceId: string;
    installationId: string;
    slackKey: string;
    conversationId: string;
  }): Promise<SlackConversationLinkRecord> {
    const [row] = await this.db.query<SlackConversationLinkRow>(
      `INSERT INTO slack_conversation_links (id, workspace_id, installation_id, slack_key, conversation_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slack_key) DO UPDATE
       SET conversation_id = EXCLUDED.conversation_id,
           installation_id = EXCLUDED.installation_id,
           updated_at = NOW()
       RETURNING id, workspace_id, installation_id, slack_key, conversation_id`,
      [randomUUID(), input.workspaceId, input.installationId, input.slackKey, input.conversationId],
    );
    return mapLink(row);
  }
}
