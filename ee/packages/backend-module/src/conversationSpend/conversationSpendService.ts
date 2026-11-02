import { sql } from "kysely";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { createEeKysely, type EeDb } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { currentPeriodStart, nextPeriodStart, previousPeriodStart } from "../usageLimits/period.js";
import {
  priceConversationSpend,
  type ConversationReplyCount,
  type ConversationSpend,
  type ModelTokenTotals,
} from "./conversationSpend.js";

interface ConversationSpendServiceConfig {
  now?: () => Date;
}

/** The current UTC month and the one before it, for reading a month that has finished. */
export interface RecentConversationSpend {
  current: ConversationSpend;
  previous: ConversationSpend;
}

const toNumber = (value: number | string | bigint | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

const groupRows = <Row extends { account_id: string }, T>(rows: readonly Row[], toEntry: (row: Row) => T): Map<string, T[]> => {
  const byAccount = new Map<string, T[]>();
  for (const row of rows) {
    const entries = byAccount.get(row.account_id) ?? [];
    entries.push(toEntry(row));
    byAccount.set(row.account_id, entries);
  }
  return byAccount;
};

/**
 * Estimates model spend per metered customer conversation from the usage ledger, on read.
 *
 * Metered conversations come from `ee_usage_limit_conversation_replies`, which the meter writes
 * for customer-channel replies only, so Test Chat, Ray, and Pulse never appear. Each is counted
 * once per block of the tier's `repliesPerConversation` replies — the tier's value now, for every
 * month read. Nothing records the value a reply was charged under, so changing it re-counts the
 * months already shown.
 *
 * Spend is every `usage_events` call recorded against one of those conversations in the same UTC
 * month that the provider billed: planning, answers, rerank, extraction, embeddings, and
 * summaries. A conversation erased since leaves both sides: its ledger rows lose their
 * conversation link, and the join to `conversations` drops its meter row.
 */
export class ConversationSpendService {
  private readonly db: EeDb;
  private readonly now: () => Date;

  constructor(database: UsageLimitDatabasePort, config: ConversationSpendServiceConfig = {}) {
    this.db = createEeKysely(database.pool);
    this.now = config.now ?? (() => new Date());
  }

  /** This month's spend, one entry per account asked for; an account with nothing metered gets a
   *  zero entry. */
  async listForAccounts(accountIds: readonly string[]): Promise<Map<string, ConversationSpend>> {
    if (accountIds.length === 0) {
      return new Map();
    }
    const repliesPerConversation = await this.readRepliesPerConversation(accountIds);
    const spendOf = await this.readPeriod(accountIds, currentPeriodStart(this.now()), repliesPerConversation);
    return new Map(accountIds.map((accountId) => [accountId, spendOf(accountId)]));
  }

  async getRecentMonths(accountId: string): Promise<RecentConversationSpend> {
    const currentPeriod = currentPeriodStart(this.now());
    const repliesPerConversation = await this.readRepliesPerConversation([accountId]);
    const [current, previous] = await Promise.all([
      this.readPeriod([accountId], currentPeriod, repliesPerConversation),
      this.readPeriod([accountId], previousPeriodStart(currentPeriod), repliesPerConversation),
    ]);
    return { current: current(accountId), previous: previous(accountId) };
  }

  private async readPeriod(
    accountIds: readonly string[],
    periodStart: string,
    repliesPerConversation: (accountId: string) => number,
  ): Promise<(accountId: string) => ConversationSpend> {
    const [replyCounts, usage] = await Promise.all([
      this.readReplyCounts(accountIds, periodStart),
      this.sumConversationTokens(accountIds, periodStart),
    ]);
    return (accountId) => priceConversationSpend({
      periodStart,
      repliesPerConversation: repliesPerConversation(accountId),
      replyCounts: replyCounts.get(accountId) ?? [],
      usage: usage.get(accountId) ?? [],
    });
  }

  /** The account's tier as assigned now, or the catalog default for an account with no tier. */
  private async readRepliesPerConversation(accountIds: readonly string[]): Promise<(accountId: string) => number> {
    const rows = await this.db
      .selectFrom("ee_usage_limit_account_assignments as assignment")
      .innerJoin("ee_usage_limit_profiles as profile", "profile.key", "assignment.profile_key")
      .select(["assignment.account_id as account_id", "profile.replies_per_conversation as replies_per_conversation"])
      .where("assignment.account_id", "in", [...accountIds])
      .execute();
    const byAccount = new Map(rows.map((row) => [row.account_id, row.replies_per_conversation]));
    return (accountId) => byAccount.get(accountId) ?? PLAN_CATALOG.repliesPerConversation;
  }

  private async readReplyCounts(
    accountIds: readonly string[],
    periodStart: string,
  ): Promise<Map<string, ConversationReplyCount[]>> {
    const rows = await this.db
      .selectFrom("ee_usage_limit_conversation_replies as replies")
      .innerJoin("conversations", "conversations.id", "replies.conversation_id")
      .select([
        "replies.account_id as account_id",
        "replies.reply_count as replies",
        sql<string>`count(*)`.as("conversations"),
      ])
      .where("replies.account_id", "in", [...accountIds])
      .where("replies.period_start", "=", sql<string>`${periodStart}::date`)
      .where("replies.reply_count", ">", 0)
      .groupBy(["replies.account_id", "replies.reply_count"])
      .execute();
    return groupRows(rows, (row) => ({ replies: row.replies, conversations: toNumber(row.conversations) }));
  }

  // A call counts when it succeeded or when the provider reported its tokens: an interrupted or
  // superseded reply stream records `failed` with the usage the provider billed. A failed call
  // with no reported usage carries an estimate from the request size and is left out, since a
  // request the provider rejected was never billed.
  private async sumConversationTokens(
    accountIds: readonly string[],
    periodStart: string,
  ): Promise<Map<string, ModelTokenTotals[]>> {
    const rows = await this.db
      .selectFrom("usage_events as event")
      .innerJoin("ee_usage_limit_conversation_replies as replies", (join) => join
        .onRef("replies.account_id", "=", "event.account_id")
        .onRef("replies.conversation_id", "=", "event.conversation_id")
        .on("replies.period_start", "=", sql<string>`${periodStart}::date`))
      .select([
        "replies.account_id as account_id",
        "event.provider as provider",
        "event.model as model",
        sql<string>`sum(event.input_tokens)`.as("input_tokens"),
        sql<string>`sum(event.output_tokens)`.as("output_tokens"),
        sql<string>`count(*)`.as("calls"),
      ])
      .where("event.account_id", "in", [...accountIds])
      .where("event.occurred_at", ">=", new Date(`${periodStart}T00:00:00.000Z`))
      .where("event.occurred_at", "<", new Date(nextPeriodStart(periodStart)))
      .where((eb) => eb.or([eb("event.status", "=", "succeeded"), eb("event.usage_quality", "=", "actual")]))
      .where("replies.reply_count", ">", 0)
      .groupBy(["replies.account_id", "event.provider", "event.model"])
      .execute();
    return groupRows(rows, (row) => ({
      provider: row.provider,
      model: row.model,
      inputTokens: toNumber(row.input_tokens),
      outputTokens: toNumber(row.output_tokens),
      calls: toNumber(row.calls),
    }));
  }
}
