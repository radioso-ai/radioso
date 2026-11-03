import modelSpendJson from "./modelSpend.json" with { type: "json" };

import type { ManagedModelProvider } from "./index.js";

/** One model's published list price, in US dollars per million tokens. */
export interface ModelListPrice {
  readonly provider: ManagedModelProvider;
  readonly model: string;
  readonly input: number;
  readonly output: number;
}

/**
 * Staff-only numbers for estimating model spend from the usage ledger's token counts. Kept apart
 * from `PLAN_CATALOG` because that catalog is public (`GET /api/v1/plans`), and these describe
 * Radioso's costs and margins rather than what a customer buys.
 *
 * Prices stay in USD as providers publish them; `eurPerUsd` converts them into the catalog
 * currency. Cached input is priced at the full input rate. A model missing from
 * `usdPerMillionTokens` is unpriced, and whoever reports spend says how many calls that left out.
 */
export interface ModelSpendEstimate {
  readonly eurPerUsd: number;
  readonly usdPerMillionTokens: readonly ModelListPrice[];
  /**
   * The monthly average model spend per metered customer conversation, in euros, above which the
   * staff console flags an account. €0.04 is where Planet at full quota drops below a 50% gross
   * margin; the levers for a flagged account are in `ee/readme.md` ("Conversation spend").
   */
  readonly conversationSpendFlagEur: number;
}

// Cast for the same reason as PLAN_CATALOG: the JSON import widens `provider` to string. The
// catalog tests assert every provider is one the backend resolves.
export const MODEL_SPEND_ESTIMATE: ModelSpendEstimate = modelSpendJson as ModelSpendEstimate;

/** Exact match on the provider and model names the usage ledger records. */
export const findModelListPrice = (provider: string, model: string): ModelListPrice | undefined =>
  MODEL_SPEND_ESTIMATE.usdPerMillionTokens.find((price) => price.provider === provider && price.model === model);
