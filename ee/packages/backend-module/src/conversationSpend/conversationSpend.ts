import { findModelListPrice, MODEL_SPEND_ESTIMATE } from "@radioso/plan-catalog";

/** Token totals for one provider/model pair, summed from the usage ledger. */
export interface ModelTokenTotals {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: number;
}

/** How many of a month's metered conversations reached a given reply count. */
export interface ConversationReplyCount {
  readonly replies: number;
  readonly conversations: number;
}

/**
 * `above`: the priced average alone exceeds the threshold, and unpriced calls could only add to
 * it. `undetermined`: the priced average is at or under it, but calls on a model with no list
 * price are missing from it. `below`: every call is priced and the average is at or under it.
 * `none`: the month metered no conversation.
 */
export type ConversationSpendFlag = "above" | "below" | "undetermined" | "none";

/**
 * An account's estimated model spend on its metered customer conversations for one UTC month,
 * at list price with cached input charged in full.
 */
export interface ConversationSpend {
  readonly periodStart: string;
  /** The tier's replies per conversation as set now, which every month shown is counted at. */
  readonly repliesPerConversation: number;
  /** One per block of `repliesPerConversation` replies in each conversation. */
  readonly meteredConversations: number;
  readonly spendEur: number;
  /** Null when the month metered no conversation, so there is nothing to average. */
  readonly averageEurPerConversation: number | null;
  readonly flagAboveEurPerConversation: number;
  readonly flag: ConversationSpendFlag;
  /** Calls on a model the catalog has no list price for; their spend is missing from `spendEur`. */
  readonly unpricedCalls: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

// Micro-euro precision: spend per conversation is cents, so six places keep every digit that
// matters and drop the float noise a sum of fractional prices picks up.
const roundEur = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const countMeteredConversations = (
  replyCounts: readonly ConversationReplyCount[],
  repliesPerConversation: number,
): number => replyCounts.reduce(
  (total, { replies, conversations }) => total + conversations * Math.ceil(replies / repliesPerConversation),
  0,
);

const resolveFlag = (average: number | null, threshold: number, unpricedCalls: number): ConversationSpendFlag => {
  if (average === null) return "none";
  if (average > threshold) return "above";
  return unpricedCalls > 0 ? "undetermined" : "below";
};

export const priceConversationSpend = (input: {
  periodStart: string;
  repliesPerConversation: number;
  replyCounts: readonly ConversationReplyCount[];
  usage: readonly ModelTokenTotals[];
}): ConversationSpend => {
  let spendUsd = 0;
  let unpricedCalls = 0;
  for (const totals of input.usage) {
    const price = findModelListPrice(totals.provider, totals.model);
    if (!price) {
      unpricedCalls += totals.calls;
      continue;
    }
    spendUsd += (totals.inputTokens * price.input + totals.outputTokens * price.output) / TOKENS_PER_PRICE_UNIT;
  }
  const meteredConversations = countMeteredConversations(input.replyCounts, input.repliesPerConversation);
  const spendEur = spendUsd * MODEL_SPEND_ESTIMATE.eurPerUsd;
  const averageEurPerConversation = meteredConversations > 0 ? roundEur(spendEur / meteredConversations) : null;
  const flagAboveEurPerConversation = MODEL_SPEND_ESTIMATE.conversationSpendFlagEur;
  return {
    periodStart: input.periodStart,
    repliesPerConversation: input.repliesPerConversation,
    meteredConversations,
    spendEur: roundEur(spendEur),
    averageEurPerConversation,
    flagAboveEurPerConversation,
    flag: resolveFlag(averageEurPerConversation, flagAboveEurPerConversation, unpricedCalls),
    unpricedCalls,
  };
};
