import { sql } from "kysely";

import type { EeDb } from "../../db/eeSchema.js";
import type { ConversationUsageLevel } from "../conversationUsageLevel.js";
import { levelsCrossedUpward } from "./alertLevelOrder.js";

/**
 * Inserts a claim for every alert level crossed upward between `before` and `after`,
 * `ON CONFLICT DO NOTHING` so a level already claimed this period is left alone. Call inside
 * `reserveTenths`'s own transaction so the claim and the usage update that caused it commit
 * together — a crash between the two would otherwise let a level go uncelebrated or uninsertable.
 */
export const claimLevelsCrossed = async (
  db: EeDb,
  input: { accountId: string; periodStart: string; before: ConversationUsageLevel; after: ConversationUsageLevel },
): Promise<void> => {
  const levels = levelsCrossedUpward(input.before, input.after);
  for (const level of levels) {
    await db
      .insertInto("ee_usage_limit_alerts")
      .values({ account_id: input.accountId, period_start: sql<string>`${input.periodStart}::date`, level })
      .onConflict((oc) => oc.columns(["account_id", "period_start", "level"]).doNothing())
      .execute();
  }
};

/**
 * Claims a `grace_exhausted` alert when a `conversation` reservation is outright refused.
 * Called OUTSIDE the refusing transaction, in its own statement, after that transaction has
 * already rolled back — `reserveTenths` never commits anything on a refusal, so there is no
 * shared transaction to extend. Swallows its own failure: a lost alert claim must never replace
 * the 429 the caller is already raising for the refusal itself.
 */
export const claimGraceExhaustedSafely = async (
  db: EeDb,
  input: { accountId: string; periodStart: string },
): Promise<void> => {
  try {
    await db
      .insertInto("ee_usage_limit_alerts")
      .values({
        account_id: input.accountId,
        period_start: sql<string>`${input.periodStart}::date`,
        level: "grace_exhausted",
      })
      .onConflict((oc) => oc.columns(["account_id", "period_start", "level"]).doNothing())
      .execute();
  } catch {
    // Best-effort; see docstring above.
  }
};

/**
 * Re-arm: deletes the current period's claims for an account, so a level reached again after a
 * top-up or a profile/plan change alerts again. Called by `addCredits` (only when a grant is
 * actually applied) and by `assignProfile`, both inside their own transaction, so `now()` here
 * is that transaction's frozen start time: a claim a concurrent reservation commits for this
 * same account while the re-arming transaction is still open has a `created_at` at or after
 * that moment, and survives instead of being swept up by a clear it raced.
 */
export const clearAlertClaims = async (
  db: EeDb,
  input: { accountId: string; periodStart: string },
): Promise<void> => {
  await db
    .deleteFrom("ee_usage_limit_alerts")
    .where("account_id", "=", input.accountId)
    .where("period_start", "=", sql<string>`${input.periodStart}::date`)
    .where("created_at", "<", sql<Date>`now()`)
    .execute();
};
