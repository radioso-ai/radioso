import { PLAN_CATALOG, STRIPE_PLAN_METADATA_KEY, type PlanId } from "@radioso/plan-catalog";

/**
 * Pure Stripe price/plan mapping helpers. Knows the catalog; must never know Stripe HTTP or the
 * database. Every caller (webhook handler, routes) reaches Stripe only through the narrow
 * `StripeGateway` port and never imports the `stripe` SDK here.
 */

export type BillingInterval = "month" | "year";

export type BillingSubscriptionStatus = "active" | "past_due" | "canceled" | "none";

/** The subset of a Stripe product this module reads: its plan-id metadata. */
interface StripeProductMetadataSource {
  metadata: Record<string, string> | null | undefined;
}

/** The subset of a Stripe price this module reads: its lookup key. */
interface StripePriceLookupKeySource {
  lookup_key: string | null | undefined;
}

/** Looks up the Stripe price lookup key for a self-serve plan + billing interval. `null` when the
 *  plan has no Stripe pricing (the free plan, or an unknown plan id). */
export const lookupKeyFor = (planId: string, interval: BillingInterval): string | null => {
  const plan = PLAN_CATALOG.plans.find((candidate) => candidate.id === planId);
  if (!plan?.stripe) {
    return null;
  }
  return interval === "year" ? plan.stripe.yearLookupKey : plan.stripe.monthLookupKey;
};

/** Resolves a Stripe product's `plan=<id>` metadata to a catalog plan id. `null` when the metadata
 *  is missing or names a plan the catalog does not sell through Stripe (e.g. the free plan). */
export const planIdForProduct = (
  product: StripeProductMetadataSource,
  metadataKey: string = STRIPE_PLAN_METADATA_KEY,
): PlanId | null => {
  const candidate = product.metadata?.[metadataKey];
  if (!candidate) {
    return null;
  }
  const plan = PLAN_CATALOG.plans.find((entry) => entry.id === candidate && entry.stripe !== null);
  return plan ? plan.id : null;
};

/** True when a price is the conversation top-up pack, identified by lookup key alone (never by
 *  Stripe price id). */
export const isTopUpPrice = (price: StripePriceLookupKeySource): boolean =>
  price.lookup_key === PLAN_CATALOG.topUp.stripeLookupKey;

/** The next self-serve plan above `planId`, in catalog order. `null` at the self-serve ceiling
 *  plan or for a plan id the catalog does not recognize. */
export const upgradePlanIdFor = (planId: string): PlanId | null => {
  if (planId === PLAN_CATALOG.selfServeCeilingPlanId) {
    return null;
  }
  const index = PLAN_CATALOG.plans.findIndex((plan) => plan.id === planId);
  if (index === -1) {
    return null;
  }
  const next = PLAN_CATALOG.plans.slice(index + 1).find((plan) => plan.stripe !== null);
  return next?.id ?? null;
};

/** Maps a raw Stripe subscription status to our narrower billing status. Unrecognized statuses
 *  (e.g. `paused`) fall back to `none` rather than throwing, since a webhook must never 500 on an
 *  unexpected-but-valid Stripe status. */
export const statusFromStripe = (status: string): BillingSubscriptionStatus => {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
    default:
      return "none";
  }
};
