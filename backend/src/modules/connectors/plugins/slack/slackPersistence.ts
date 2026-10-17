import { randomUUID } from "node:crypto";
import type { ConversationChannelContext } from "@radioso/conversation-contract";

import { ConversationRepository } from "../../../../db/repositories/conversationRepository.js";
import type { BackgroundJobQueue, BackgroundJobRequest } from "../../../../shared/background-jobs/index.js";
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

export interface SlackConversationLinkCreateOutcome {
  link: SlackConversationLinkRecord;
  created: boolean;
}

export type SlackInboundEventStatus = "received" | "processed" | "skipped" | "failed";

export interface SlackPersistencePort {
  /**
   * Dedupes by event id; `status` defaults to `received` (a job is about to be enqueued for it) but
   * a caller that already knows the event will not be dispatched — unparseable, bot-authored —
   * passes `skipped` directly, so there is no window between "recorded" and "marked" a crash could
   * leave stuck.
   */
  createInboundEvent(input: { eventId: string; teamId: string }, status?: SlackInboundEventStatus): Promise<boolean>;
  /**
   * Transitions away from `received` only: a write that finds the event already `processed`,
   * `skipped`, or `failed` is a no-op, so an attempt abandoned after its lease was reclaimed can
   * never clobber the status a later attempt (or the port's own dead-letter hook) already settled.
   * `executor` lets a caller write inside its own transaction, such as a dead-letter park.
   */
  markInboundEventStatus(eventId: string, status: "processed" | "skipped" | "failed", executor?: Db): Promise<void>;
  getInboundEventStatus(eventId: string): Promise<SlackInboundEventStatus | null>;
  /**
   * Dedupes and enqueues in one transaction: the inbound-event row and its background job are
   * written together, so a job-write failure rolls back the dedupe row too and Slack's own
   * redelivery can try again, rather than finding a "received" row with no job behind it.
   */
  enqueueInboundEvent(input: { eventId: string; teamId: string; job: BackgroundJobRequest }): Promise<"duplicate" | "enqueued">;
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
  }): Promise<SlackConversationLinkCreateOutcome>;
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
    /** Needed only by {@link enqueueInboundEvent}; the API webhook supplies it, the worker's
     *  job-dispatch instance never calls that method and may omit it. */
    private readonly backgroundJobs?: Pick<BackgroundJobQueue, "enqueueInTransaction" | "wake">,
  ) {}

  async createInboundEvent(input: { eventId: string; teamId: string }, status: SlackInboundEventStatus = "received"): Promise<boolean> {
    const row = await this.db
      .insertInto("slack_inbound_events")
      .values({ event_id: input.eventId, team_id: input.teamId, status })
      .onConflict((oc) => oc.column("event_id").doNothing())
      .returning("event_id")
      .executeTakeFirst();
    return row !== undefined;
  }

  async enqueueInboundEvent(input: { eventId: string; teamId: string; job: BackgroundJobRequest }): Promise<"duplicate" | "enqueued"> {
    if (!this.backgroundJobs) {
      throw new Error("PostgresSlackPersistence.enqueueInboundEvent requires a backgroundJobs queue");
    }
    const backgroundJobs = this.backgroundJobs;
    const outcome = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("slack_inbound_events")
        .values({ event_id: input.eventId, team_id: input.teamId, status: "received" })
        .onConflict((oc) => oc.column("event_id").doNothing())
        .returning("event_id")
        .executeTakeFirst();
      if (!row) {
        return "duplicate" as const;
      }
      await backgroundJobs.enqueueInTransaction(trx, input.job);
      return "enqueued" as const;
    });
    if (outcome === "enqueued") {
      void backgroundJobs.wake();
    }
    return outcome;
  }

  async markInboundEventStatus(eventId: string, status: "processed" | "skipped" | "failed", executor?: Db): Promise<void> {
    await (executor ?? this.db)
      .updateTable("slack_inbound_events")
      .set({ status })
      .where("event_id", "=", eventId)
      .where("status", "=", "received")
      .execute();
  }

  async getInboundEventStatus(eventId: string): Promise<SlackInboundEventStatus | null> {
    const row = await this.db
      .selectFrom("slack_inbound_events")
      .select("status")
      .where("event_id", "=", eventId)
      .executeTakeFirst();
    return (row?.status as SlackInboundEventStatus | undefined) ?? null;
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
  }): Promise<SlackConversationLinkCreateOutcome> {
    const conflict = new Error("slack_conversation_link_conflict");
    try {
      return await this.db.transaction().execute(async (trx) => {
        await transactionAdvisoryLock(`slack_conversation:${input.slackKey}`).execute(trx);
        const existing = await trx
          .selectFrom("slack_conversation_links")
          .select(["id", "workspace_id", "installation_id", "slack_key", "conversation_id"])
          .where("workspace_id", "=", input.workspaceId)
          .where("slack_key", "=", input.slackKey)
          .executeTakeFirst();
        if (existing) {
          return { link: mapLink(existing), created: false };
        }

        const conversation = await new ConversationRepository(trx).create({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          sourceChannel: input.sourceChannel,
          channelContext: input.channelContext,
        });
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
        return { link: mapLink(inserted), created: true };
      });
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
      return { link: winner, created: false };
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
