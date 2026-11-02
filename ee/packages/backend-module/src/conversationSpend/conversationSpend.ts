import { findModelListPrice, PLAN_CATALOG } from "@radioso/plan-catalog";

/** Token totals for one provider/model pair, summed from the usage ledger. */
export interface ModelTokenTotals {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly calls: number;
}

/**
 * An account's estimated model spend on its metered customer conversations for one UTC month,
 * at catalog list price with cached input charged in full.
 */
export interface ConversationSpend {
  readonly periodStart: string;
  /** One per block of the tier's `repliesPerConversation` replies, the unit the meter charges. */
  readonly meteredConversations: number;
  readonly spendEur: number;
  /** Null when the month metered no conversation, so there is nothing to average. */
  readonly averageEurPerConversation: number | null;
  readonly flagAboveEurPerConversation: number;
  readonly flagged: boolean;
  /** Calls on a model the catalog has no list price for; their spend is missing from `spendEur`. */
  readonly unpricedCalls: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

// Micro-euro precision: spend per conversation is cents, so six places keep every digit that
// matters and drop the float noise a sum of fractional prices picks up.
const roundEur = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export const priceConversationSpend = (input: {
  periodStart: string;
  meteredConversations: number;
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
  const spendEur = spendUsd * PLAN_CATALOG.modelListPrices.eurPerUsd;
  const averageEurPerConversation = input.meteredConversations > 0
    ? roundEur(spendEur / input.meteredConversations)
    : null;
  const flagAboveEurPerConversation = PLAN_CATALOG.conversationSpendFlagEur;
  return {
    periodStart: input.periodStart,
    meteredConversations: input.meteredConversations,
    spendEur: roundEur(spendEur),
    averageEurPerConversation,
    flagAboveEurPerConversation,
    flagged: averageEurPerConversation !== null && averageEurPerConversation > flagAboveEurPerConversation,
    unpricedCalls,
  };
};
