import { PLAN_CATALOG, STRIPE_PLAN_METADATA_KEY, type PlanId } from "@radioso/plan-catalog";

import type { MailTransport } from "../radiosoModuleTypes.js";
import type { BillingCustomerRepository } from "./billingCustomerRepository.js";
import { isTopUpPrice, planIdForProduct, statusFromStripe } from "./planPricing.js";
import type { StripeGateway, StripeWebhookEvent } from "./stripeGateway.js";

/** The subset of `EnterpriseUsageLimitService` this handler needs -- narrow enough that a fake
 *  satisfies it in tests without depending on the real service. */
export interface BillingUsageLimitPort {
  assignProfile(accountId: string, profileKey: string): Promise<unknown>;
  addCredits(input: { accountId: string; conversations: number; reference: string }): Promise<{
    credits: number;
    applied: boolean;
  }>;
}

export interface BillingAuditPort {
  record(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: "success" | "failure";
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export interface BillingWebhookLogger {
  info(entry: Record<string, unknown>, message?: string): void;
  warn(entry: Record<string, unknown>, message?: string): void;
}

export interface BillingWebhookHandlerDeps {
  repository: BillingCustomerRepository;
  usage: BillingUsageLimitPort;
  gateway: Pick<StripeGateway, "getProduct">;
  mail: MailTransport;
  audit: BillingAuditPort;
  logger: BillingWebhookLogger;
  /** Base dashboard URL used only for the payment-failed email's link. */
  appBaseUrl: string;
  metadataKey?: string;
}

interface BillingWebhookResult {
  outcome: string;
}

const toDate = (unixSeconds: number | null): Date | null =>
  unixSeconds === null ? null : new Date(unixSeconds * 1000);

/** Outcomes that warrant a `warn` line instead of `info` (per the design memo's logging rule). */
const WARN_OUTCOMES = new Set(["unmapped_price", "unknown_customer"]);

const logOutcome = (
  logger: BillingWebhookLogger,
  event: { id: string; type: string },
  accountId: string | null,
  outcome: string,
): void => {
  const entry = { eventId: event.id, type: event.type, accountId, outcome };
  if (WARN_OUTCOMES.has(outcome)) {
    logger.warn(entry, "billing webhook");
  } else {
    logger.info(entry, "billing webhook");
  }
};

/**
 * Claims the event id inside a transaction, then runs `apply` only if the claim succeeded.
 * `markEventProcessed` is called exactly once, BEFORE any side effect, so a failure inside
 * `apply` rolls back the claim along with everything `apply` wrote -- a retry sees no marker and
 * tries again. A duplicate delivery sees the claim fail and `apply` never runs.
 */
const applyIdempotently = async (
  repository: BillingCustomerRepository,
  claim: { eventId: string; eventType: string; accountId: string; outcome: string },
  apply: (tx: BillingCustomerRepository) => Promise<void>,
): Promise<"applied" | "duplicate"> =>
  repository.withTransaction(async (tx) => {
    const claimed = await tx.markEventProcessed(claim);
    if (!claimed) {
      return "duplicate";
    }
    await apply(tx);
    return "applied";
  });

const resolvePlanId = async (
  deps: BillingWebhookHandlerDeps,
  productId: string | null,
): Promise<PlanId | null> => {
  if (!productId) {
    return null;
  }
  const product = await deps.gateway.getProduct(productId);
  return product ? planIdForProduct(product, deps.metadataKey ?? STRIPE_PLAN_METADATA_KEY) : null;
};

const handleCheckoutCompleted = async (
  event: Extract<StripeWebhookEvent, { type: "checkout.session.completed" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { session } = event;
  if (!session.clientReferenceId) {
    return { outcome: "unknown_customer", accountId: null };
  }
  const accountId = session.clientReferenceId;

  if (session.mode === "payment") {
    if (!isTopUpPrice({ lookup_key: session.priceLookupKey })) {
      return { outcome: "unmapped_price", accountId };
    }
    const result = await applyIdempotently(
      deps.repository,
      { eventId: event.id, eventType: event.type, accountId, outcome: "credits_granted" },
      async () => {
        await deps.usage.addCredits({
          accountId,
          conversations: PLAN_CATALOG.topUp.conversations,
          reference: event.id,
        });
      },
    );
    if (result === "duplicate") {
      return { outcome: "duplicate", accountId };
    }
    await deps.audit.record({
      accountId,
      workspaceId: null,
      eventType: "billing.credits_granted",
      eventStatus: "success",
      metadata: { eventId: event.id, eventType: event.type, conversations: PLAN_CATALOG.topUp.conversations },
    });
    return { outcome: "credits_granted", accountId };
  }

  // mode === "subscription" (or "setup", which we never sell -- treated the same as an
  // unresolvable price rather than a distinct branch).
  const planId = await resolvePlanId(deps, session.productId);
  if (!planId || !session.customerId) {
    return { outcome: "unmapped_price", accountId };
  }

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome: "plan_assigned" },
    async (tx) => {
      await tx.upsertCustomer({
        accountId,
        stripeCustomerId: session.customerId!,
        stripeSubscriptionId: session.subscriptionId,
        priceId: session.priceId,
        interval: session.interval,
        status: "active",
        currentPeriodEnd: toDate(session.currentPeriodEnd),
      });
      await deps.usage.assignProfile(accountId, planId);
    },
  );
  if (result === "duplicate") {
    return { outcome: "duplicate", accountId };
  }
  await deps.audit.record({
    accountId,
    workspaceId: null,
    eventType: "billing.plan_assigned",
    eventStatus: "success",
    metadata: { eventId: event.id, eventType: event.type, planId },
  });
  return { outcome: "plan_assigned", accountId };
};

const handleSubscriptionUpdated = async (
  event: Extract<StripeWebhookEvent, { type: "customer.subscription.updated" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { subscription } = event;
  const row = await deps.repository.findByStripeCustomer(subscription.customerId);
  if (!row) {
    return { outcome: "unknown_customer", accountId: null };
  }
  const accountId = row.accountId;
  const status = statusFromStripe(subscription.status);
  const priceChanged = subscription.priceId !== null && subscription.priceId !== row.priceId;

  let planId: PlanId | null = null;
  if (priceChanged) {
    planId = await resolvePlanId(deps, subscription.productId);
  }
  const outcome = priceChanged && !planId ? "unmapped_price" : priceChanged ? "plan_assigned" : "subscription_updated";
  if (outcome === "unmapped_price") {
    return { outcome, accountId };
  }

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome },
    async (tx) => {
      await tx.upsertCustomer({
        accountId,
        stripeCustomerId: subscription.customerId,
        stripeSubscriptionId: subscription.id,
        priceId: subscription.priceId,
        interval: subscription.interval,
        status,
        currentPeriodEnd: toDate(subscription.currentPeriodEnd),
      });
      if (priceChanged && planId) {
        await deps.usage.assignProfile(accountId, planId);
      }
    },
  );
  if (result === "duplicate") {
    return { outcome: "duplicate", accountId };
  }
  if (outcome === "plan_assigned") {
    await deps.audit.record({
      accountId,
      workspaceId: null,
      eventType: "billing.plan_assigned",
      eventStatus: "success",
      metadata: { eventId: event.id, eventType: event.type, planId },
    });
  }
  return { outcome, accountId };
};

const handleSubscriptionDeleted = async (
  event: Extract<StripeWebhookEvent, { type: "customer.subscription.deleted" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { subscription } = event;
  const row = await deps.repository.findByStripeCustomer(subscription.customerId);
  if (!row) {
    return { outcome: "unknown_customer", accountId: null };
  }
  const accountId = row.accountId;
  const planId = PLAN_CATALOG.defaultPlanId;

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome: "subscription_canceled" },
    async (tx) => {
      await tx.upsertCustomer({ accountId, stripeCustomerId: subscription.customerId, status: "canceled" });
      await deps.usage.assignProfile(accountId, planId);
    },
  );
  if (result === "duplicate") {
    return { outcome: "duplicate", accountId };
  }
  await deps.audit.record({
    accountId,
    workspaceId: null,
    eventType: "billing.subscription_canceled",
    eventStatus: "success",
    metadata: { eventId: event.id, eventType: event.type, planId },
  });
  return { outcome: "subscription_canceled", accountId };
};

const handleInvoicePaid = async (
  event: Extract<StripeWebhookEvent, { type: "invoice.paid" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { invoice } = event;
  const row = await deps.repository.findByStripeCustomer(invoice.customerId);
  if (!row) {
    return { outcome: "unknown_customer", accountId: null };
  }
  const accountId = row.accountId;

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome: "active" },
    async (tx) => {
      await tx.upsertCustomer({ accountId, stripeCustomerId: invoice.customerId, status: "active" });
    },
  );
  return { outcome: result === "duplicate" ? "duplicate" : "active", accountId };
};

const handleInvoicePaymentFailed = async (
  event: Extract<StripeWebhookEvent, { type: "invoice.payment_failed" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { invoice } = event;
  const row = await deps.repository.findByStripeCustomer(invoice.customerId);
  if (!row) {
    return { outcome: "unknown_customer", accountId: null };
  }
  const accountId = row.accountId;

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome: "payment_failed" },
    async (tx) => {
      // Never downgrades: Stripe's own dunning handles retries, and `customer.subscription.deleted`
      // is the only trigger back to the free plan.
      await tx.upsertCustomer({ accountId, stripeCustomerId: invoice.customerId, status: "past_due" });
      if (row.billingEmail) {
        await deps.mail.send({
          to: row.billingEmail,
          subject: "Your Radioso payment didn't go through",
          text: [
            "We couldn't process your latest payment.",
            `Update your billing details: ${deps.appBaseUrl}`,
          ].join("\n"),
        });
      }
    },
  );
  if (result === "duplicate") {
    return { outcome: "duplicate", accountId };
  }
  await deps.audit.record({
    accountId,
    workspaceId: null,
    eventType: "billing.payment_failed",
    eventStatus: "success",
    metadata: { eventId: event.id, eventType: event.type },
  });
  return { outcome: "payment_failed", accountId };
};

export const handleBillingWebhookEvent = async (
  event: StripeWebhookEvent,
  deps: BillingWebhookHandlerDeps,
): Promise<BillingWebhookResult> => {
  // The union's catch-all member (`{ id: string; type: string }`, for event types we never act
  // on) has a non-literal `type`, so `switch (event.type)` cannot narrow it away from the literal
  // cases below -- each branch re-asserts the member the runtime switch already guarantees.
  let result: { outcome: string; accountId: string | null };
  switch (event.type) {
    case "checkout.session.completed":
      result = await handleCheckoutCompleted(
        event as Extract<StripeWebhookEvent, { type: "checkout.session.completed" }>,
        deps,
      );
      break;
    case "customer.subscription.updated":
      result = await handleSubscriptionUpdated(
        event as Extract<StripeWebhookEvent, { type: "customer.subscription.updated" }>,
        deps,
      );
      break;
    case "customer.subscription.deleted":
      result = await handleSubscriptionDeleted(
        event as Extract<StripeWebhookEvent, { type: "customer.subscription.deleted" }>,
        deps,
      );
      break;
    case "invoice.paid":
      result = await handleInvoicePaid(event as Extract<StripeWebhookEvent, { type: "invoice.paid" }>, deps);
      break;
    case "invoice.payment_failed":
      result = await handleInvoicePaymentFailed(
        event as Extract<StripeWebhookEvent, { type: "invoice.payment_failed" }>,
        deps,
      );
      break;
    default:
      result = { outcome: "ignored", accountId: null };
      break;
  }
  logOutcome(deps.logger, event, result.accountId, result.outcome);
  return { outcome: result.outcome };
};
