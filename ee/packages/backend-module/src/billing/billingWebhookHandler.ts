import { PLAN_CATALOG, STRIPE_PLAN_METADATA_KEY, findPlan, type PlanId } from "@radioso/plan-catalog";

import type { AccountAdministratorDirectoryPort, NoticeMailPort } from "../radiosoModuleTypes.js";
import type { BillingCustomerRepository } from "./billingCustomerRepository.js";
import type { AutoTopUpRepository } from "./autoTopUpRepository.js";
import {
  buildAutoTopUpFailedEmail,
  buildPaymentFailedEmail,
  buildPlanChangedEmail,
  buildSubscriptionEndedEmail,
  resolveBillingNoticeRecipients,
} from "./billingEmailContent.js";
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
  autoTopUps: Pick<AutoTopUpRepository, "markPaid" | "markFailed" | "disable">;
  noticeMail: NoticeMailPort;
  accountAdministrators: AccountAdministratorDirectoryPort;
  audit: BillingAuditPort;
  logger: BillingWebhookLogger;
  /** Base dashboard URL used only for a branded notice's call to action. */
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
 * `markEventProcessed` is called exactly once, BEFORE any side effect. The claim and the
 * customer-row writes share the transaction, so a failure rolls them back together and Stripe's
 * retry sees no marker. Usage-service calls (`assignProfile`, `addCredits`) and the auto-top-up
 * row/settings writes run on their own connections and are NOT covered by the rollback -- they
 * are safe to re-run only because each is idempotent on its own, and because this claim already
 * guarantees `apply` runs at most once per event id. Keep anything non-idempotent out of `apply`.
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

/**
 * Sends one branded notice to active owners + admins, plus the customer's billing email when it
 * differs (deduped). Called only AFTER the triggering transaction has committed -- every caller
 * awaits `applyIdempotently` first -- and is itself best-effort: any failure (resolving
 * recipients, or any individual send) is logged and swallowed, never raised to the webhook
 * caller. A webhook must return 200 on its own side effects alone; a notice email is a courtesy,
 * not part of the contract Stripe retries against.
 */
const sendBillingNotice = async (
  deps: BillingWebhookHandlerDeps,
  input: {
    accountId: string;
    billingEmail: string | null;
    eventId: string;
    build: () => { subject: string; content: Parameters<NoticeMailPort["send"]>[0]["content"] };
  },
): Promise<void> => {
  try {
    const administrators = await deps.accountAdministrators.list(input.accountId);
    const recipients = resolveBillingNoticeRecipients(administrators, input.billingEmail);
    if (recipients.length === 0) {
      return;
    }
    const { subject, content } = input.build();
    const results = await Promise.allSettled(
      recipients.map((email) =>
        deps.noticeMail.send({
          to: email,
          subject,
          kind: "billing_notice",
          content,
          idempotencyKey: `billing:${input.eventId}:${email}`,
        }),
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        deps.logger.warn(
          { accountId: input.accountId, eventId: input.eventId, error: String(result.reason) },
          "billing notice email failed",
        );
      }
    }
  } catch (error) {
    deps.logger.warn({ accountId: input.accountId, eventId: input.eventId, error: String(error) }, "billing notice email failed");
  }
};

const planDisplay = (planId: string): { name: string; monthlyConversations: number } => {
  const plan = findPlan(planId);
  return { name: plan?.name ?? planId, monthlyConversations: plan?.monthlyConversations ?? 0 };
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
  const billingRow = await deps.repository.findByAccount(accountId);
  const display = planDisplay(planId);
  await sendBillingNotice(deps, {
    accountId,
    billingEmail: billingRow?.billingEmail ?? null,
    eventId: event.id,
    build: () => buildPlanChangedEmail({ accountId, planName: display.name, monthlyConversations: display.monthlyConversations, appBaseUrl: deps.appBaseUrl }),
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
  if (outcome === "plan_assigned" && planId) {
    await deps.audit.record({
      accountId,
      workspaceId: null,
      eventType: "billing.plan_assigned",
      eventStatus: "success",
      metadata: { eventId: event.id, eventType: event.type, planId },
    });
    const display = planDisplay(planId);
    await sendBillingNotice(deps, {
      accountId,
      billingEmail: row.billingEmail,
      eventId: event.id,
      build: () => buildPlanChangedEmail({ accountId, planName: display.name, monthlyConversations: display.monthlyConversations, appBaseUrl: deps.appBaseUrl }),
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
  const display = planDisplay(planId);
  await sendBillingNotice(deps, {
    accountId,
    billingEmail: row.billingEmail,
    eventId: event.id,
    build: () => buildSubscriptionEndedEmail({ accountId, planName: display.name, monthlyConversations: display.monthlyConversations, appBaseUrl: deps.appBaseUrl }),
  });
  return { outcome: "subscription_canceled", accountId };
};

const handleInvoicePaid = async (
  event: Extract<StripeWebhookEvent, { type: "invoice.paid" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { invoice } = event;

  if (invoice.metadata.radioso_kind === "auto_top_up") {
    return handleAutoTopUpInvoicePaid(event, deps);
  }

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

/**
 * `invoice.paid` for a pack created by the auto-top-up sweep (`radioso_kind: auto_top_up` in the
 * invoice's own metadata, read before any customer lookup). Grants the catalog's top-up credits
 * idempotently -- `addCredits` dedupes on `reference` and repays any grace debt first, same as a
 * one-off top-up purchase -- resolves the row to `paid`, and leaves the subscription's status
 * row untouched: this invoice is out of band from the subscription's own billing cycle.
 */
const handleAutoTopUpInvoicePaid = async (
  event: Extract<StripeWebhookEvent, { type: "invoice.paid" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { invoice } = event;
  const accountId = invoice.metadata.account_id;
  const autoTopUpId = invoice.metadata.auto_top_up_id;
  if (!accountId || !autoTopUpId) {
    return { outcome: "unmapped_price", accountId: accountId ?? null };
  }

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome: "auto_top_up_paid" },
    async () => {
      await deps.usage.addCredits({
        accountId,
        conversations: PLAN_CATALOG.topUp.conversations,
        reference: `auto_top_up:${invoice.id}`,
      });
      await deps.autoTopUps.markPaid(autoTopUpId);
    },
  );
  if (result === "duplicate") {
    return { outcome: "duplicate", accountId };
  }
  await deps.audit.record({
    accountId,
    workspaceId: null,
    eventType: "billing.auto_top_up_paid",
    eventStatus: "success",
    metadata: { eventId: event.id, autoTopUpId, conversations: PLAN_CATALOG.topUp.conversations },
  });
  return { outcome: "auto_top_up_paid", accountId };
};

const handleInvoicePaymentFailed = async (
  event: Extract<StripeWebhookEvent, { type: "invoice.payment_failed" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { invoice } = event;

  if (invoice.metadata.radioso_kind === "auto_top_up") {
    return handleAutoTopUpInvoicePaymentFailed(event, deps);
  }

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
  await sendBillingNotice(deps, {
    accountId,
    billingEmail: row.billingEmail,
    eventId: event.id,
    build: () => buildPaymentFailedEmail({ accountId, appBaseUrl: deps.appBaseUrl }),
  });
  return { outcome: "payment_failed", accountId };
};

/**
 * `invoice.payment_failed` for an auto-top-up pack. Disables auto top-up (never fails the
 * webhook on a declined one-off charge by setting the subscription itself `past_due` -- the
 * subscription row is never touched here), marks the row `failed`, and emails owners + admins so
 * a human can fix the payment method and turn it back on.
 */
const handleAutoTopUpInvoicePaymentFailed = async (
  event: Extract<StripeWebhookEvent, { type: "invoice.payment_failed" }>,
  deps: BillingWebhookHandlerDeps,
): Promise<{ outcome: string; accountId: string | null }> => {
  const { invoice } = event;
  const accountId = invoice.metadata.account_id;
  const autoTopUpId = invoice.metadata.auto_top_up_id;
  if (!accountId || !autoTopUpId) {
    return { outcome: "unmapped_price", accountId: accountId ?? null };
  }

  const result = await applyIdempotently(
    deps.repository,
    { eventId: event.id, eventType: event.type, accountId, outcome: "auto_top_up_failed" },
    async () => {
      await deps.autoTopUps.markFailed({ id: autoTopUpId, failureCode: "payment_failed" });
      await deps.autoTopUps.disable({ accountId, reason: "payment_failed" });
    },
  );
  if (result === "duplicate") {
    return { outcome: "duplicate", accountId };
  }
  await deps.audit.record({
    accountId,
    workspaceId: null,
    eventType: "billing.auto_top_up_failed",
    eventStatus: "success",
    metadata: { eventId: event.id, autoTopUpId, hasHostedInvoiceUrl: invoice.hostedInvoiceUrl !== null },
  });
  const billingRow = await deps.repository.findByAccount(accountId);
  await sendBillingNotice(deps, {
    accountId,
    billingEmail: billingRow?.billingEmail ?? null,
    eventId: event.id,
    build: () => buildAutoTopUpFailedEmail({ accountId, appBaseUrl: deps.appBaseUrl, hostedInvoiceUrl: invoice.hostedInvoiceUrl }),
  });
  return { outcome: "auto_top_up_failed", accountId };
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
