import { sql } from "kysely";

import type { UsageCountKind } from "@radioso/plan-catalog";

import type { EeDb } from "../db/eeSchema.js";
import type { UsageLimitReservation } from "../radiosoModuleTypes.js";

interface MonthlyCaps {
  monthlyAnswerLimit: number | null;
  monthlyConversationLimit: number | null;
}

/**
 * Every account is metered; its tier only picks the unit and the cap. A tier that caps answers
 * and not conversations keeps the legacy answer meter. Every other account, untiered included,
 * is metered in conversations, and refused only when its tier sets a conversation limit.
 */
export const meteredInAnswers = <T extends MonthlyCaps>(
  caps: T | null,
): caps is T & { monthlyAnswerLimit: number } =>
  caps !== null
  && typeof caps.monthlyConversationLimit !== "number"
  && typeof caps.monthlyAnswerLimit === "number";

export const bumpConversationReplies = async (
  db: EeDb,
  input: { accountId: string; periodStart: string; conversationId: string; delta: 1 | -1 },
): Promise<number> => {
  const row = await db
    .insertInto("ee_usage_limit_conversation_replies")
    .values({
      account_id: input.accountId,
      period_start: sql<string>`${input.periodStart}::date`,
      conversation_id: input.conversationId,
      reply_count: input.delta > 0 ? 1 : 0,
    })
    .onConflict((oc) =>
      oc.columns(["account_id", "period_start", "conversation_id"]).doUpdateSet({
        reply_count: sql<number>`greatest(ee_usage_limit_conversation_replies.reply_count + ${input.delta}, 0)`,
        updated_at: sql<Date>`now()`,
      }),
    )
    .returning("reply_count")
    .executeTakeFirstOrThrow();
  return row.reply_count;
};

/**
 * Meters an account no conversation limit governs into the same counters a capped account
 * spends, so the staff console reads one meter for every account. Nothing here refuses,
 * draws on credits, or claims usage alerts: each of those needs a limit to measure against.
 */
export const recordUncappedTenths = async (
  db: EeDb,
  input: { accountId: string; periodStart: string; kind: UsageCountKind; tenths: number },
): Promise<UsageLimitReservation> => {
  const { accountId, periodStart, kind, tenths } = input;
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("ee_usage_limit_unit_counters")
      .values({ account_id: accountId, period_start: sql<string>`${periodStart}::date`, used_tenths: tenths })
      .onConflict((oc) =>
        oc.columns(["account_id", "period_start"]).doUpdateSet({
          used_tenths: sql<number>`ee_usage_limit_unit_counters.used_tenths + ${tenths}`,
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
    await trx
      .insertInto("ee_usage_limit_unit_kind_counters")
      .values({ account_id: accountId, period_start: sql<string>`${periodStart}::date`, kind, used_tenths: tenths })
      .onConflict((oc) =>
        oc.columns(["account_id", "period_start", "kind"]).doUpdateSet({
          used_tenths: sql<number>`ee_usage_limit_unit_kind_counters.used_tenths + ${tenths}`,
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();
  });

  return {
    async commit() {},
    release: async () => {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("ee_usage_limit_unit_counters")
          .set({ used_tenths: sql<number>`greatest(used_tenths - ${tenths}, 0)`, updated_at: sql<Date>`now()` })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .execute();
        await trx
          .updateTable("ee_usage_limit_unit_kind_counters")
          .set({ used_tenths: sql<number>`greatest(used_tenths - ${tenths}, 0)`, updated_at: sql<Date>`now()` })
          .where("account_id", "=", accountId)
          .where("period_start", "=", sql<string>`${periodStart}::date`)
          .where("kind", "=", kind)
          .execute();
      });
    },
  };
};
