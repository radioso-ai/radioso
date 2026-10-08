/**
 * The single owner of conversation-usage-level math: what the account's plan allowance plus
 * prepaid credits can still absorb (`capacity`), how much of the account-wide grace borrow a
 * customer conversation may still draw on (`grace`), and the resulting level. `reserveTenths` in
 * `usageLimitService.ts` uses `graceLimitTenths` to cap how far a `conversation` reservation may
 * push the credit balance negative; `/me` and the Ray `workspace_usage_limits` tool both call
 * `conversationUsageLevel` to report the same numbers back to operators. Pure and DB-free so every
 * caller — including a future alert-threshold detector — computes the same answer from the same
 * inputs.
 */

/** Tenths of a conversation per conversation: the common unit across every usage kind, so "ten test runs are one" stays integer math. */
export const TENTHS_PER_CONVERSATION = 10;

export type ConversationUsageLevel = "ok" | "nearing_limit" | "limit_reached" | "grace_exhausted";

export interface ConversationGrace {
  /** Conversations the account may still borrow as debt, in whole conversations. Account-wide,
   *  not period-scoped: it depends only on the profile's limit, not on which period is being read. */
  limit: number;
  /** Conversations currently borrowed (the negative part of the credit balance), in whole conversations. */
  borrowed: number;
}

// Not exported: only conversationUsageLevel's own signature needs this shape today. Callers
// read it structurally (`const { capacity, grace, level } = conversationUsageLevel(...)`); export
// it the day a second module needs to name the shape itself, rather than ahead of that need.
interface ConversationUsageLevelResult {
  /** Conversations spendable before borrowing: max(used, limit) + max(balance, 0). */
  capacity: number;
  grace: ConversationGrace;
  level: ConversationUsageLevel;
}

/**
 * The account-wide grace a `conversation` reservation may still borrow past the plan limit and
 * prepaid credits, in tenths. Flooring happens in whole conversations, not tenths: a 0.1 share of
 * a 47-conversation plan borrows 4 whole conversations (40 tenths), not 4.7.
 */
export const graceLimitTenths = (limitTenths: number, graceShare: number): number =>
  Math.floor((limitTenths / TENTHS_PER_CONVERSATION) * graceShare) * TENTHS_PER_CONVERSATION;

// Not exported for the same reason as ConversationUsageLevelResult above.
interface ConversationUsageLevelInput {
  usedTenths: number;
  /** The profile's monthly conversation limit in tenths, or null when the profile is unmetered. */
  limitTenths: number | null;
  /** `ee_usage_limit_credits.balance_tenths`. May be negative once a conversation has borrowed. */
  balanceTenths: number;
  /** `PLAN_CATALOG.conversationGraceShare`. */
  graceShare: number;
  /** The `conversation` kind's own weight in tenths — "one conversation" for the grace_exhausted check. */
  conversationWeightTenths: number;
}

export const conversationUsageLevel = (input: ConversationUsageLevelInput): ConversationUsageLevelResult => {
  const { usedTenths, limitTenths, balanceTenths, graceShare, conversationWeightTenths } = input;

  if (limitTenths === null) {
    return {
      capacity: (usedTenths + Math.max(balanceTenths, 0)) / TENTHS_PER_CONVERSATION,
      grace: { limit: 0, borrowed: 0 },
      level: "ok",
    };
  }

  const borrowedTenths = Math.max(-balanceTenths, 0);
  const graceTenths = graceLimitTenths(limitTenths, graceShare);
  const capacityTenths = Math.max(usedTenths, limitTenths) + Math.max(balanceTenths, 0);
  const paidRemainingTenths = capacityTenths - usedTenths;
  // Clamped to zero: debt already larger than the grace (e.g. carried across a plan
  // downgrade) must shrink this to no headroom, never to a negative number that would
  // subtract from paidRemainingTenths below and misreport a healthy account as exhausted.
  const remainingGraceTenths = Math.max(graceTenths - borrowedTenths, 0);

  let level: ConversationUsageLevel;
  if (paidRemainingTenths + remainingGraceTenths < conversationWeightTenths) {
    level = "grace_exhausted";
  } else if (paidRemainingTenths <= 0) {
    level = "limit_reached";
  } else if (capacityTenths > 0 && usedTenths / capacityTenths >= 0.8) {
    level = "nearing_limit";
  } else {
    level = "ok";
  }

  return {
    capacity: capacityTenths / TENTHS_PER_CONVERSATION,
    grace: { limit: graceTenths / TENTHS_PER_CONVERSATION, borrowed: borrowedTenths / TENTHS_PER_CONVERSATION },
    level,
  };
};
