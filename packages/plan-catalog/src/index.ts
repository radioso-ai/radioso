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
  readonly storedBytes: number;
  readonly monthlyIndexedBytes: number;
  readonly documents: number;
  readonly models: PlanModels;
  readonly support: PlanSupport;
  /** Null on the free plan: nothing to buy. */
  readonly stripe: PlanStripePricing | null;
}

export interface PlanTopUp {
  readonly conversations: number;
  readonly priceCents: number;
  readonly stripeLookupKey: string;
}

export interface PlanManagedService {
  readonly priceCents: number;
  readonly interval: "month";
  readonly stripeLookupKey: string;
}

export type UsageCountKind = "conversation" | "copilot" | "test_run" | "pulse_report" | "other";

export type PlanUsageWeights = Readonly<Record<UsageCountKind, number>>;

export interface PlanCatalog {
  readonly currency: string;
  readonly plans: readonly Plan[];
  readonly defaultPlanId: PlanId;
  readonly selfServeCeilingPlanId: PlanId;
  readonly repliesPerConversation: number;
  readonly countsAs: PlanUsageWeights;
  readonly topUp: PlanTopUp;
  readonly managedService: PlanManagedService;
}

// `resolveJsonModule` infers widened primitive types (string, number) for JSON literals, not the
// literal-union types plan ids and enum-like fields carry here, so the JSON import cannot satisfy
// `PlanCatalog` by direct assignment. The catalog invariants suite is the compile-time check's
// runtime counterpart: it asserts the literal values this annotation cannot.
export const PLAN_CATALOG: PlanCatalog = plansJson as PlanCatalog;

export const findPlan = (id: string): Plan | undefined =>
  PLAN_CATALOG.plans.find((plan) => plan.id === id);

export const formatPrice = (cents: number, currency: string = PLAN_CATALOG.currency): string => {
  const isWhole = cents % 100 === 0;
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    minimumFractionDigits: isWhole ? 0 : 2,
    maximumFractionDigits: isWhole ? 0 : 2,
  }).format(cents / 100);
};
