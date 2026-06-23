import { randomUUID } from "node:crypto";

import { currentTimestamp } from "../../../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../../../shared/infra/kysely/types.js";

export interface SlackConversationLinkRecord {
  id: string;
  workspaceId: string;
  installationId: string;
  slackKey: string;
  conversationId: string;
}

export interface SlackPersistencePort {
  createInboundEvent(input: { eventId: string; teamId: string }): Promise<boolean>;
  markInboundEventStatus(eventId: string, status: "processed" | "skipped" | "failed"): Promise<void>;
  markStaleInboundEventsFailed(input: { olderThan: Date }): Promise<number>;
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
  constructor(private readonly db: Db) {}

  async createInboundEvent(input: { eventId: string; teamId: string }): Promise<boolean> {
    const row = await this.db
      .insertInto("slack_inbound_events")
      .values({ event_id: input.eventId, team_id: input.teamId, status: "received" })
      .onConflict((oc) => oc.column("event_id").doNothing())
      .returning("event_id")
      .executeTakeFirst();
    return row !== undefined;
  }

  async markInboundEventStatus(eventId: string, status: "processed" | "skipped" | "failed"): Promise<void> {
    await this.db
      .updateTable("slack_inbound_events")
      .set({ status })
      .where("event_id", "=", eventId)
      .execute();
  }

  async markStaleInboundEventsFailed(input: { olderThan: Date }): Promise<number> {
    const rows = await this.db
      .updateTable("slack_inbound_events")
      .set({ status: "failed" })
      .where("status", "=", "received")
      .where("received_at", "<", input.olderThan)
      .returning("event_id")
      .execute();
    return rows.length;
  }

  async findConversationLink(input: {
    workspaceId: string;
    slackKey: string;
  }): Promise<SlackConversationLinkRecord | null> {
    const row = await this.db
      .selectFrom("slack_conversation_links")
      .select(["id", "workspace_id", "installation_id", "slack_key", "conversation_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("slack_key", "=", input.slackKey)
      .executeTakeFirst();
    return row ? mapLink(row) : null;
  }

  async upsertConversationLink(input: {
    workspaceId: string;
    installationId: string;
    slackKey: string;
    conversationId: string;
  }): Promise<SlackConversationLinkRecord> {
    const row = await this.db
      .insertInto("slack_conversation_links")
      .values({
        id: randomUUID(),
        workspace_id: input.workspaceId,
        installation_id: input.installationId,
        slack_key: input.slackKey,
        conversation_id: input.conversationId,
      })
      .onConflict((oc) =>
        oc.column("slack_key").doUpdateSet((eb) => ({
          conversation_id: eb.ref("excluded.conversation_id"),
          installation_id: eb.ref("excluded.installation_id"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(["id", "workspace_id", "installation_id", "slack_key", "conversation_id"])
      .executeTakeFirstOrThrow();
    return mapLink(row);
  }
}
