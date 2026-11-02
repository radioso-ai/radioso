import plansJson from "./plans.json" with { type: "json" };

export type PlanId = "comet" | "satellite" | "planet";

export type PlanModels = "managed" | "byok";

export type PlanSupport = "community" | "email" | "priority";

/**
 * How the app finds a plan in Stripe. Prices are looked up by `lookup_key` at checkout time, so a
 * price change is a new Stripe price with the key transferred (`transfer_lookup_key`) — no app
 * config changes. Webhooks go the other way, price → plan, by reading the plan id from the Stripe
 * product's metadata under {@link STRIPE_PLAN_METADATA_KEY}; every price on that product, current
 * or grandfathered, resolves to the same plan.
 */
export interface PlanStripePricing {
  readonly monthLookupKey: string;
  readonly yearLookupKey: string;
}

/** Stripe product metadata key whose value is the plan id (`satellite`, `planet`). */
export const STRIPE_PLAN_METADATA_KEY = "plan";

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  readonly priceCents: number;
  readonly annualPriceCents: number | null;
  readonly interval: "month";
  readonly monthlyConversations: number;
  /** Contact and operator-notification recipient emails allowed per workspace per UTC day. */
  readonly dailyNotificationEmails: number;
  readonly storedBytes: number;
  readonly monthlyIndexedBytes: number;
  readonly documents: number;
  readonly models: PlanModels;
  readonly support: PlanSupport;
  /**
   * Whether the prepaid conversation top-up pack is sold on this plan. `false` on the free plan
   * (CFO-approved 2026-09-15): a free account plus a few top-up packs would undercut the cheapest
   * paid plan. An account on a plan id the catalog does not list (a legacy or hand-assigned
   * profile) is likewise ineligible — see `isTopUpEligible` in the backend module's billing code.
   */
  readonly topUps: boolean;
  /** Null on the free plan: nothing to buy. */
  readonly stripe: PlanStripePricing | null;
}

export interface PlanTopUp {
  readonly conversations: number;
  readonly priceCents: number;
  readonly stripeLookupKey: string;
}

/**
 * Opt-in auto top-up's per-account pack cap. `defaultMaxPacksPerMonth` is the cap a newly
 * enabled account starts with; `maxPacksPerMonthLimit` is the upper bound an account may raise
 * it to. The pack itself is the existing {@link PlanTopUp}; only a plan with `topUps: true` may
 * enable auto top-up at all.
 */
export interface PlanAutoTopUp {
  readonly defaultMaxPacksPerMonth: number;
  readonly maxPacksPerMonthLimit: number;
}

/** The provider names the backend's capability resolver accepts. */
export type ManagedModelProvider = "openai" | "openai-compatible" | "gemini" | "claude";

/** A provider/model pair as the backend's capability resolver names them. */
export interface ManagedModelSelection {
  readonly provider: ManagedModelProvider;
  readonly model: string;
}

/**
 * The model set a workspace on a `models: "managed"` plan runs when it has no provider key of its
 * own. `chat` covers answers and Ray; `default` covers every other text capability (rewrite,
 * rerank). Embeddings are never managed. This is the only place these model names live.
 */
export interface PlanManagedModels {
  readonly chat: ManagedModelSelection;
  readonly default: ManagedModelSelection;
}

/** One model's published list price, in US dollars per million tokens. */
export interface ModelListPrice {
  readonly provider: ManagedModelProvider;
  readonly model: string;
  readonly input: number;
  readonly output: number;
}

/**
 * Provider list prices for the models Radioso Cloud runs, used to estimate model spend from the
 * token counts in the usage ledger. Prices stay in USD as providers publish them; `eurPerUsd`
 * converts them into the catalog currency. Cached input is priced at the full input rate, so an
 * estimate is an upper bound on what the provider bills. A model missing here is unpriced, and
 * whoever reports spend says how many calls that left out.
 */
export interface PlanModelListPrices {
  readonly eurPerUsd: number;
  readonly usdPerMillionTokens: readonly ModelListPrice[];
}

export type UsageCountKind = "conversation" | "copilot" | "test_run" | "pulse_report" | "other";

export type PlanUsageWeights = Readonly<Record<UsageCountKind, number>>;

/**
 * Whether catalog prices include VAT. Every Stripe price the catalog defines carries this as its
 * `tax_behavior`; `exclusive` means Stripe Tax adds VAT on top of the catalog number at checkout.
 */
export type PlanTaxBehavior = "exclusive" | "inclusive";

export interface PlanCatalog {
  readonly currency: string;
  readonly taxBehavior: PlanTaxBehavior;
  readonly plans: readonly Plan[];
  readonly defaultPlanId: PlanId;
  readonly selfServeCeilingPlanId: PlanId;
  readonly repliesPerConversation: number;
  /**
   * The share of a profile's monthly conversation limit a customer conversation may still
   * borrow once the plan allowance and prepaid credits both run out, as a negative credit
   * balance (debt the next top-up repays; a period reset alone does not). Internal usage kinds (Ray, test runs,
   * Pulse) never borrow. `0.1` on a 50-conversation plan borrows 5.
   */
  readonly conversationGraceShare: number;
  readonly countsAs: PlanUsageWeights;
  readonly topUp: PlanTopUp;
  readonly autoTopUp: PlanAutoTopUp;
  readonly managedModels: PlanManagedModels;
  readonly modelListPrices: PlanModelListPrices;
  /**
   * The monthly average model spend per metered customer conversation, in euros, above which the
   * staff console flags an account. €0.04 is where Planet at full quota drops below a 50% gross
   * margin; the levers for a flagged account are in `ee/readme.md` ("Conversation spend").
   */
  readonly conversationSpendFlagEur: number;
}

// `resolveJsonModule` infers widened primitive types (string, number) for JSON literals, not the
// literal-union types plan ids and enum-like fields carry here, so the JSON import cannot satisfy
// `PlanCatalog` by direct assignment. The catalog invariants suite is the compile-time check's
// runtime counterpart: it asserts the literal values this annotation cannot.
export const PLAN_CATALOG: PlanCatalog = plansJson as PlanCatalog;

export const findPlan = (id: string): Plan | undefined =>
  PLAN_CATALOG.plans.find((plan) => plan.id === id);

/** Exact match on the provider and model names the usage ledger records. */
export const findModelListPrice = (provider: string, model: string): ModelListPrice | undefined =>
  PLAN_CATALOG.modelListPrices.usdPerMillionTokens.find((price) => price.provider === provider && price.model === model);

export const formatPrice = (cents: number, currency: string = PLAN_CATALOG.currency): string => {
  const isWhole = cents % 100 === 0;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).format(cents / 100);
};
