import { randomUUID } from "node:crypto";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { ConversationRepository } from "../../../../db/repositories/conversationRepository.js";
import type { WorkspaceEventBus } from "../../../../shared/events/workspaceEventBus.js";
import {
  currentTimestamp,
  transactionAdvisoryLock,
} from "../../../../shared/infra/kysely/sqlHelpers.js";
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
  findConversationLinkByConversationId(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<Pick<SlackConversationLinkRecord, "slackKey" | "installationId"> | null>;
  getOrCreateConversationLink(input: {
    workspaceId: string;
    installationId: string;
    slackKey: string;
    agentId: string;
    sourceChannel: string;
    channelContext: ConversationChannelContext;
  }): Promise<SlackConversationLinkRecord>;
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
  constructor(
    private readonly db: Db,
    // A new inbound Slack conversation is created inside the link transaction via
    // a raw repository, so it bypasses the composition-decorated repository; this
    // narrow port lets it emit conversation.created after the transaction commits.
    private readonly workspaceEventBus?: Pick<WorkspaceEventBus, "publish">,
  ) {}

  private async publishConversationCreated(record: { id: string; workspaceId: string }): Promise<void> {
    if (!this.workspaceEventBus) {
      return;
    }
    await this.workspaceEventBus.publish({
      resourceType: "conversation",
      resourceId: record.id,
      workspaceId: record.workspaceId,
      changeKind: "conversation.created",
    });
  }

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

  async findConversationLinkByConversationId(input: {
    workspaceId: string;
    conversationId: string;
  }): Promise<Pick<SlackConversationLinkRecord, "slackKey" | "installationId"> | null> {
    const row = await this.db
      .selectFrom("slack_conversation_links")
      .select(["slack_key", "installation_id"])
      .where("workspace_id", "=", input.workspaceId)
      .where("conversation_id", "=", input.conversationId)
      .executeTakeFirst();
    return row ? {
      slackKey: row.slack_key,
      installationId: row.installation_id,
    } : null;
  }

  async getOrCreateConversationLink(input: {
    workspaceId: string;
    installationId: string;
    slackKey: string;
    agentId: string;
    sourceChannel: string;
    channelContext: ConversationChannelContext;
  }): Promise<SlackConversationLinkRecord> {
    const conflict = new Error("slack_conversation_link_conflict");
    let createdConversation: { id: string; workspaceId: string } | null = null;
    try {
      const link = await this.db.transaction().execute(async (trx) => {
        await transactionAdvisoryLock(`slack_conversation:${input.slackKey}`).execute(trx);
        const existing = await trx
          .selectFrom("slack_conversation_links")
          .select(["id", "workspace_id", "installation_id", "slack_key", "conversation_id"])
          .where("workspace_id", "=", input.workspaceId)
          .where("slack_key", "=", input.slackKey)
          .executeTakeFirst();
        if (existing) {
          return mapLink(existing);
        }

        const conversation = await new ConversationRepository(trx).create(
          input.workspaceId,
          input.agentId,
          input.sourceChannel,
          null,
          null,
          input.channelContext,
        );
        const inserted = await trx
          .insertInto("slack_conversation_links")
          .values({
            id: randomUUID(),
            workspace_id: input.workspaceId,
            installation_id: input.installationId,
            slack_key: input.slackKey,
            conversation_id: conversation.id,
          })
          .onConflict((oc) => oc.column("slack_key").doNothing())
          .returning(["id", "workspace_id", "installation_id", "slack_key", "conversation_id"])
          .executeTakeFirst();
        if (!inserted) {
          // Roll back the candidate conversation. The winner is read after this
          // transaction releases its snapshot and advisory lock.
          throw conflict;
        }
        createdConversation = { id: conversation.id, workspaceId: input.workspaceId };
        return mapLink(inserted);
      });
      // Publish after commit so a rolled-back candidate never emits an event.
      if (createdConversation) {
        await this.publishConversationCreated(createdConversation);
      }
      return link;
    } catch (error) {
      if (error !== conflict) {
        throw error;
      }
      const winner = await this.findConversationLink({
        workspaceId: input.workspaceId,
        slackKey: input.slackKey,
      });
      if (!winner) {
        throw new Error("slack_conversation_link_winner_missing");
      }
      return winner;
    }
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
