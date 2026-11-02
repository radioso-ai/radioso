import { sql } from "kysely";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { createEeKysely, type EeDb } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { currentPeriodStart, nextPeriodStart, previousPeriodStart } from "../usageLimits/period.js";
import { priceConversationSpend, type ConversationSpend, type ModelTokenTotals } from "./conversationSpend.js";

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

/**
 * Estimates model spend per metered customer conversation from the usage ledger, on read.
 *
 * A metered conversation is what the conversation meter charged: a row in
 * `ee_usage_limit_conversation_replies` (written for customer-channel replies only, so Test Chat,
 * Ray, and Pulse never appear) counted once per block of the tier's `repliesPerConversation`
 * replies. Spend is every succeeded `usage_events` call recorded against one of those
 * conversations in the same UTC month — planning, answers, rerank, extraction, embeddings, and
 * summaries alike. A conversation erased since leaves both sides: its ledger rows lose their
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
    const spendOf = await this.readPeriod(accountIds, currentPeriodStart(this.now()));
    return new Map(accountIds.map((accountId) => [accountId, spendOf(accountId)]));
  }

  async getRecentMonths(accountId: string): Promise<RecentConversationSpend> {
    const currentPeriod = currentPeriodStart(this.now());
    const [current, previous] = await Promise.all([
      this.readPeriod([accountId], currentPeriod),
      this.readPeriod([accountId], previousPeriodStart(currentPeriod)),
    ]);
    return { current: current(accountId), previous: previous(accountId) };
  }

  private async readPeriod(
    accountIds: readonly string[],
    periodStart: string,
  ): Promise<(accountId: string) => ConversationSpend> {
    const [metered, usage] = await Promise.all([
      this.countMeteredConversations(accountIds, periodStart),
      this.sumConversationTokens(accountIds, periodStart),
    ]);
    return (accountId) => priceConversationSpend({
      periodStart,
      meteredConversations: metered.get(accountId) ?? 0,
      usage: usage.get(accountId) ?? [],
    });
  }

  // Blocks use the account's current tier, falling back to the catalog default for an account
  // with no tier; a tier edited mid-month re-buckets that month's long conversations.
  private async countMeteredConversations(
    accountIds: readonly string[],
    periodStart: string,
  ): Promise<Map<string, number>> {
    const rows = await this.db
      .selectFrom("ee_usage_limit_conversation_replies as replies")
      .innerJoin("conversations", "conversations.id", "replies.conversation_id")
      .leftJoin("ee_usage_limit_account_assignments as assignment", "assignment.account_id", "replies.account_id")
      .leftJoin("ee_usage_limit_profiles as profile", "profile.key", "assignment.profile_key")
      .select([
        "replies.account_id as account_id",
        sql<string>`sum(ceil(
          replies.reply_count::numeric
          / coalesce(profile.replies_per_conversation, ${PLAN_CATALOG.repliesPerConversation})
        ))`.as("metered_conversations"),
      ])
      .where("replies.account_id", "in", [...accountIds])
      .where("replies.period_start", "=", sql<string>`${periodStart}::date`)
      .where("replies.reply_count", ">", 0)
      .groupBy("replies.account_id")
      .execute();
    return new Map(rows.map((row) => [row.account_id, toNumber(row.metered_conversations)]));
  }

  // Failed calls are left out, the same as the daily usage rollup: their token counts are
  // estimated from the request size, and a request the provider rejected was never billed.
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
      .where("event.status", "=", "succeeded")
      .where("replies.reply_count", ">", 0)
      .groupBy(["replies.account_id", "event.provider", "event.model"])
      .execute();
    const byAccount = new Map<string, ModelTokenTotals[]>();
    for (const row of rows) {
      const totals = byAccount.get(row.account_id) ?? [];
      totals.push({
        provider: row.provider,
        model: row.model,
        inputTokens: toNumber(row.input_tokens),
        outputTokens: toNumber(row.output_tokens),
        calls: toNumber(row.calls),
      });
      byAccount.set(row.account_id, totals);
    }
    return byAccount;
  }
}
