import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { PLAN_CATALOG, findPlan } from "@radioso/plan-catalog";

import type {
  BillingCustomerPatch,
  BillingCustomerRepository,
  BillingCustomerRow,
  ProcessedEventClaim,
} from "./billingCustomerRepository.js";
import { handleBillingWebhookEvent, type BillingWebhookHandlerDeps } from "./billingWebhookHandler.js";
import {
  STRIPE_WEBHOOK_EVENT_TYPES,
  type StripeHandledWebhookEventType,
  type StripeWebhookEvent,
} from "./stripeGateway.js";

/** In-memory fake. `withTransaction` runs the callback against the same fake (no real rollback --
 *  transactional atomicity is covered by `billingCustomerRepository.integration.test.ts`). */
class FakeBillingCustomerRepository implements BillingCustomerRepository {
  rows = new Map<string, BillingCustomerRow>();
  processedEvents = new Set<string>();

  async findByAccount(accountId: string): Promise<BillingCustomerRow | null> {
    return this.rows.get(accountId) ?? null;
  }

  async findByStripeCustomer(stripeCustomerId: string): Promise<BillingCustomerRow | null> {
    for (const row of this.rows.values()) {
      if (row.stripeCustomerId === stripeCustomerId) {
        return row;
      }
    }
    return null;
  }

  async upsertCustomer(patch: BillingCustomerPatch): Promise<BillingCustomerRow> {
    const hasOwn = (key: keyof BillingCustomerPatch): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);
    const existing = this.rows.get(patch.accountId);
    const now = new Date();
    const row: BillingCustomerRow = {
      accountId: patch.accountId,
      stripeCustomerId: patch.stripeCustomerId,
      stripeSubscriptionId: hasOwn("stripeSubscriptionId")
        ? patch.stripeSubscriptionId ?? null
        : existing?.stripeSubscriptionId ?? null,
      priceId: hasOwn("priceId") ? patch.priceId ?? null : existing?.priceId ?? null,
      interval: hasOwn("interval") ? patch.interval ?? null : existing?.interval ?? null,
      status: hasOwn("status") ? patch.status ?? "none" : existing?.status ?? "none",
      billingEmail: hasOwn("billingEmail") ? patch.billingEmail ?? null : existing?.billingEmail ?? null,
      currentPeriodEnd: hasOwn("currentPeriodEnd")
        ? patch.currentPeriodEnd ?? null
        : existing?.currentPeriodEnd ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(patch.accountId, row);
    return row;
  }

  async markEventProcessed(claim: ProcessedEventClaim): Promise<boolean> {
    if (this.processedEvents.has(claim.eventId)) {
      return false;
    }
    this.processedEvents.add(claim.eventId);
    return true;
  }

  async withTransaction<T>(callback: (tx: BillingCustomerRepository) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const createDeps = (overrides: Partial<BillingWebhookHandlerDeps> = {}): {
  deps: BillingWebhookHandlerDeps;
  repository: FakeBillingCustomerRepository;
  assignProfile: ReturnType<typeof vi.fn>;
  addCredits: ReturnType<typeof vi.fn>;
  getProduct: ReturnType<typeof vi.fn>;
  markPaid: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  disableAutoTopUp: ReturnType<typeof vi.fn>;
  noticeMailSend: ReturnType<typeof vi.fn>;
  accountAdministratorsList: ReturnType<typeof vi.fn>;
  auditRecord: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} => {
  const repository = new FakeBillingCustomerRepository();
  const assignProfile = vi.fn(async () => undefined);
  const addCredits = vi.fn(async () => ({ credits: 300, applied: true }));
  const getProduct = vi.fn(async (id: string) => ({ id, metadata: {} }));
  const markPaid = vi.fn(async () => undefined);
  const markFailed = vi.fn(async () => undefined);
  const disableAutoTopUp = vi.fn(async () => undefined);
  const noticeMailSend = vi.fn(async () => ({ dispatched: true }));
  const accountAdministratorsList = vi.fn(async () => [{ email: "owner@example.com", displayName: "Owner" }]);
  const auditRecord = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };

  const deps: BillingWebhookHandlerDeps = {
    repository,
    usage: { assignProfile, addCredits },
    gateway: { getProduct },
    autoTopUps: { markPaid, markFailed, disable: disableAutoTopUp },
    noticeMail: { send: noticeMailSend },
    accountAdministrators: { list: accountAdministratorsList },
    audit: { record: auditRecord },
    logger,
    appBaseUrl: "https://app.example.com",
    ...overrides,
  };
  return {
    deps,
    repository,
    assignProfile,
    addCredits,
    getProduct,
    markPaid,
    markFailed,
    disableAutoTopUp,
    noticeMailSend,
    accountAdministratorsList,
    auditRecord,
    logger,
  };
};

const satellitePlan = PLAN_CATALOG.plans.find((plan) => plan.id === "satellite")!;
const planetPlan = PLAN_CATALOG.plans.find((plan) => plan.id === "planet")!;

/** Every test that triggers a best-effort branded email awaits the handler's own promise, which
 *  already awaits `sendBillingNotice` internally before returning -- no extra flush needed. */
describe("handleBillingWebhookEvent", () => {
  let accountId: string;

  beforeEach(() => {
    accountId = randomUUID();
  });

  it("checkout.session.completed (subscription) upserts the customer row, assigns the plan, and emails the plan change", async () => {
    const { deps, repository, assignProfile, auditRecord, getProduct, noticeMailSend } = createDeps();
    getProduct.mockResolvedValueOnce({ id: "prod_satellite", metadata: { plan: "satellite" } });
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: null,
      priceId: null,
      interval: null,
      status: "none",
      billingEmail: "billing@example.com",
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event: StripeWebhookEvent = {
      id: "evt_1",
      type: "checkout.session.completed",
      session: {
        id: "cs_1",
        mode: "subscription",
        customerId: "cus_1",
        clientReferenceId: accountId,
        subscriptionId: "sub_1",
        priceId: satellitePlan.stripe!.monthLookupKey,
        priceLookupKey: satellitePlan.stripe!.monthLookupKey,
        productId: "prod_satellite",
        interval: "month",
        currentPeriodEnd: 1_700_000_000,
      },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("plan_assigned");
    expect(assignProfile).toHaveBeenCalledWith(accountId, "satellite");
    expect(repository.rows.get(accountId)?.status).toBe("active");
    expect(repository.rows.get(accountId)?.stripeSubscriptionId).toBe("sub_1");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventType: "billing.plan_assigned" }),
    );
    expect(noticeMailSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com", kind: "billing_notice" }),
    );
    expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "billing@example.com" }));
    const content = noticeMailSend.mock.calls[0][0].content;
    expect(content.paragraphs.join(" ")).toContain(`Satellite: ${satellitePlan.monthlyConversations} conversations a month`);
  });

  it("checkout.session.completed (payment) grants the catalog's top-up credits, idempotent on event id", async () => {
    const { deps, addCredits, auditRecord } = createDeps();

    const event: StripeWebhookEvent = {
      id: "evt_2",
      type: "checkout.session.completed",
      session: {
        id: "cs_2",
        mode: "payment",
        customerId: "cus_1",
        clientReferenceId: accountId,
        subscriptionId: null,
        priceId: "price_topup",
        priceLookupKey: PLAN_CATALOG.topUp.stripeLookupKey,
        productId: null,
        interval: null,
        currentPeriodEnd: null,
      },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("credits_granted");
    expect(addCredits).toHaveBeenCalledWith({
      accountId,
      conversations: PLAN_CATALOG.topUp.conversations,
      reference: "evt_2",
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventType: "billing.credits_granted" }),
    );
  });

  it("customer.subscription.updated assigns the new plan and emails the plan change when the price changed", async () => {
    const { deps, repository, assignProfile, getProduct, noticeMailSend } = createDeps();
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: satellitePlan.stripe!.monthLookupKey,
      interval: "month",
      status: "active",
      billingEmail: "owner@example.com",
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    getProduct.mockResolvedValueOnce({ id: "prod_planet", metadata: { plan: "planet" } });

    const event: StripeWebhookEvent = {
      id: "evt_3",
      type: "customer.subscription.updated",
      subscription: {
        id: "sub_1",
        customerId: "cus_1",
        status: "active",
        priceId: planetPlan.stripe!.monthLookupKey,
        productId: "prod_planet",
        interval: "month",
        currentPeriodEnd: 1_700_100_000,
      },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("plan_assigned");
    expect(assignProfile).toHaveBeenCalledWith(accountId, "planet");
    expect(repository.rows.get(accountId)?.priceId).toBe(planetPlan.stripe!.monthLookupKey);
    expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
  });

  it("customer.subscription.updated only syncs the row when the price is unchanged, and sends no email", async () => {
    const { deps, assignProfile, noticeMailSend } = createDeps();
    const { repository } = createDeps();
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: satellitePlan.stripe!.monthLookupKey,
      interval: "month",
      status: "active",
      billingEmail: null,
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    deps.repository = repository;

    const event: StripeWebhookEvent = {
      id: "evt_4",
      type: "customer.subscription.updated",
      subscription: {
        id: "sub_1",
        customerId: "cus_1",
        status: "active",
        priceId: satellitePlan.stripe!.monthLookupKey,
        productId: "prod_satellite",
        interval: "month",
        currentPeriodEnd: 1_700_200_000,
      },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("subscription_updated");
    expect(assignProfile).not.toHaveBeenCalled();
    expect(noticeMailSend).not.toHaveBeenCalled();
  });

  it("customer.subscription.deleted returns the account to the catalog's default plan and emails that the subscription ended", async () => {
    const { deps, repository, assignProfile, auditRecord, noticeMailSend } = createDeps();
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: satellitePlan.stripe!.monthLookupKey,
      interval: "month",
      status: "active",
      billingEmail: "owner@example.com",
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event: StripeWebhookEvent = {
      id: "evt_5",
      type: "customer.subscription.deleted",
      subscription: {
        id: "sub_1",
        customerId: "cus_1",
        status: "canceled",
        priceId: null,
        productId: null,
        interval: null,
        currentPeriodEnd: null,
      },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("subscription_canceled");
    expect(assignProfile).toHaveBeenCalledWith(accountId, PLAN_CATALOG.defaultPlanId);
    expect(repository.rows.get(accountId)?.status).toBe("canceled");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventType: "billing.subscription_canceled" }),
    );
    expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
    const content = noticeMailSend.mock.calls[0][0].content;
    const defaultPlan = findPlan(PLAN_CATALOG.defaultPlanId)!;
    expect(content.paragraphs.join(" ")).toContain(`${defaultPlan.name}: ${defaultPlan.monthlyConversations} conversations a month`);
  });

  it("invoice.paid (subscription) sets the row active and never assigns a plan or sends an email", async () => {
    const { deps, repository, assignProfile, noticeMailSend } = createDeps();
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: satellitePlan.stripe!.monthLookupKey,
      interval: "month",
      status: "past_due",
      billingEmail: "owner@example.com",
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event: StripeWebhookEvent = {
      id: "evt_6",
      type: "invoice.paid",
      invoice: { id: "in_1", customerId: "cus_1", metadata: {}, hostedInvoiceUrl: null },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("active");
    expect(repository.rows.get(accountId)?.status).toBe("active");
    expect(assignProfile).not.toHaveBeenCalled();
    expect(noticeMailSend).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed (subscription) marks past_due, emails owners/admins and the billing address, and never downgrades", async () => {
    const { deps, repository, assignProfile, auditRecord, noticeMailSend } = createDeps();
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: satellitePlan.stripe!.monthLookupKey,
      interval: "month",
      status: "active",
      billingEmail: "billing@example.com",
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event: StripeWebhookEvent = {
      id: "evt_7",
      type: "invoice.payment_failed",
      invoice: { id: "in_2", customerId: "cus_1", metadata: {}, hostedInvoiceUrl: null },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("payment_failed");
    expect(repository.rows.get(accountId)?.status).toBe("past_due");
    expect(assignProfile).not.toHaveBeenCalled();
    expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
    expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "billing@example.com" }));
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventType: "billing.payment_failed" }),
    );
  });

  it("invoice.payment_failed (subscription) still emails owners/admins when there is no distinct billing address", async () => {
    const { deps, repository, noticeMailSend } = createDeps();
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: null,
      interval: null,
      status: "active",
      billingEmail: null,
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event: StripeWebhookEvent = {
      id: "evt_8",
      type: "invoice.payment_failed",
      invoice: { id: "in_3", customerId: "cus_1", metadata: {}, hostedInvoiceUrl: null },
    };

    await handleBillingWebhookEvent(event, deps);

    expect(noticeMailSend).toHaveBeenCalledTimes(1);
    expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
  });

  it("invoice.payment_failed never fails the webhook when the notice email itself errors", async () => {
    const { deps, repository, logger } = createDeps({
      noticeMail: { send: vi.fn(async () => { throw new Error("mail provider down"); }) },
    });
    repository.rows.set(accountId, {
      accountId,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      priceId: null,
      interval: null,
      status: "active",
      billingEmail: null,
      currentPeriodEnd: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const event: StripeWebhookEvent = {
      id: "evt_8b",
      type: "invoice.payment_failed",
      invoice: { id: "in_3b", customerId: "cus_1", metadata: {}, hostedInvoiceUrl: null },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("payment_failed");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventId: "evt_8b" }),
      "billing notice email failed",
    );
  });

  it("returns unmapped_price and warns when the product has no catalog plan metadata", async () => {
    const { deps, assignProfile, logger } = createDeps();

    const event: StripeWebhookEvent = {
      id: "evt_9",
      type: "checkout.session.completed",
      session: {
        id: "cs_9",
        mode: "subscription",
        customerId: "cus_1",
        clientReferenceId: accountId,
        subscriptionId: "sub_9",
        priceId: "price_unknown",
        priceLookupKey: "price_unknown",
        productId: "prod_unknown",
        interval: "month",
        currentPeriodEnd: null,
      },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("unmapped_price");
    expect(assignProfile).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unmapped_price" }),
      expect.any(String),
    );
  });

  it("returns unknown_customer and warns when no row matches the Stripe customer id", async () => {
    const { deps, logger } = createDeps();

    const event: StripeWebhookEvent = {
      id: "evt_10",
      type: "invoice.paid",
      invoice: { id: "in_4", customerId: "cus_unrecognized", metadata: {}, hostedInvoiceUrl: null },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("unknown_customer");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown_customer" }),
      expect.any(String),
    );
  });

  it("replaying the same event id is a no-op the second time", async () => {
    const { deps, addCredits, auditRecord } = createDeps();
    const event: StripeWebhookEvent = {
      id: "evt_11",
      type: "checkout.session.completed",
      session: {
        id: "cs_11",
        mode: "payment",
        customerId: "cus_1",
        clientReferenceId: accountId,
        subscriptionId: null,
        priceId: "price_topup",
        priceLookupKey: PLAN_CATALOG.topUp.stripeLookupKey,
        productId: null,
        interval: null,
        currentPeriodEnd: null,
      },
    };

    const first = await handleBillingWebhookEvent(event, deps);
    const second = await handleBillingWebhookEvent(event, deps);

    expect(first.outcome).toBe("credits_granted");
    expect(second.outcome).toBe("duplicate");
    expect(addCredits).toHaveBeenCalledTimes(1);
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });

  it("acts on every event type the webhook endpoint subscribes to", async () => {
    // The typed payload union and the subscribed list name the same event types...
    type TypedEventType<E> = E extends { type: infer K extends string } ? (string extends K ? never : K) : never;
    expectTypeOf<TypedEventType<StripeWebhookEvent>>().toEqualTypeOf<StripeHandledWebhookEventType>();

    // ...and the handler acts on each of them. Keyed by the list, so a type added there without a
    // payload here fails to compile.
    const customerId = "cus_unknown";
    const subscription = {
      id: "sub_1",
      customerId,
      status: "active",
      priceId: null,
      productId: null,
      interval: null,
      currentPeriodEnd: null,
    };
    const events: { [K in StripeHandledWebhookEventType]: Extract<StripeWebhookEvent, { type: K }> } = {
      "checkout.session.completed": {
        id: "evt_sub_1",
        type: "checkout.session.completed",
        session: {
          id: "cs_1",
          mode: "subscription",
          customerId,
          clientReferenceId: null,
          subscriptionId: null,
          priceId: null,
          priceLookupKey: null,
          productId: null,
          interval: null,
          currentPeriodEnd: null,
        },
      },
      "customer.subscription.updated": { id: "evt_sub_2", type: "customer.subscription.updated", subscription },
      "customer.subscription.deleted": { id: "evt_sub_3", type: "customer.subscription.deleted", subscription },
      "invoice.paid": { id: "evt_sub_4", type: "invoice.paid", invoice: { id: "in_1", customerId, metadata: {}, hostedInvoiceUrl: null } },
      "invoice.payment_failed": {
        id: "evt_sub_5",
        type: "invoice.payment_failed",
        invoice: { id: "in_2", customerId, metadata: {}, hostedInvoiceUrl: null },
      },
    };

    for (const type of STRIPE_WEBHOOK_EVENT_TYPES) {
      const { deps } = createDeps();
      const result = await handleBillingWebhookEvent(events[type], deps);
      expect(result.outcome, type).not.toBe("ignored");
    }
  });

  it("ignores event types outside the billing table without touching the repository", async () => {
    const { deps, repository } = createDeps();
    const claimSpy = vi.spyOn(repository, "markEventProcessed");

    const event: StripeWebhookEvent = { id: "evt_12", type: "payment_intent.succeeded" };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("ignored");
    expect(claimSpy).not.toHaveBeenCalled();
  });

  describe("auto top-up invoices (radioso_kind metadata)", () => {
    it("invoice.paid grants credits idempotently, marks the row paid, and leaves the subscription status untouched", async () => {
      const { deps, repository, addCredits, markPaid, auditRecord } = createDeps();
      repository.rows.set(accountId, {
        accountId,
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        priceId: satellitePlan.stripe!.monthLookupKey,
        interval: "month",
        status: "active",
        billingEmail: null,
        currentPeriodEnd: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const autoTopUpId = randomUUID();
      const event: StripeWebhookEvent = {
        id: "evt_atu_1",
        type: "invoice.paid",
        invoice: {
          id: "in_atu_1",
          customerId: "cus_1",
          metadata: { radioso_kind: "auto_top_up", account_id: accountId, auto_top_up_id: autoTopUpId },
          hostedInvoiceUrl: null,
        },
      };

      const first = await handleBillingWebhookEvent(event, deps);
      const second = await handleBillingWebhookEvent(event, deps);

      expect(first.outcome).toBe("auto_top_up_paid");
      expect(second.outcome).toBe("duplicate");
      expect(addCredits).toHaveBeenCalledTimes(1);
      expect(addCredits).toHaveBeenCalledWith({
        accountId,
        conversations: PLAN_CATALOG.topUp.conversations,
        reference: "auto_top_up:in_atu_1",
      });
      expect(markPaid).toHaveBeenCalledTimes(1);
      expect(markPaid).toHaveBeenCalledWith(autoTopUpId);
      // The subscription row itself is untouched by the auto-top-up path.
      expect(repository.rows.get(accountId)?.status).toBe("active");
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ accountId, eventType: "billing.auto_top_up_paid" }),
      );
    });

    it("invoice.payment_failed disables auto top-up, marks the row failed, emails owners/admins, and does not set past_due", async () => {
      const { deps, repository, markFailed, disableAutoTopUp, auditRecord, noticeMailSend } = createDeps();
      repository.rows.set(accountId, {
        accountId,
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        priceId: satellitePlan.stripe!.monthLookupKey,
        interval: "month",
        status: "active",
        billingEmail: "billing@example.com",
        currentPeriodEnd: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const autoTopUpId = randomUUID();
      const event: StripeWebhookEvent = {
        id: "evt_atu_2",
        type: "invoice.payment_failed",
        invoice: {
          id: "in_atu_2",
          customerId: "cus_1",
          metadata: { radioso_kind: "auto_top_up", account_id: accountId, auto_top_up_id: autoTopUpId },
          hostedInvoiceUrl: "https://invoice.stripe.com/i/atu2",
        },
      };

      const result = await handleBillingWebhookEvent(event, deps);

      expect(result.outcome).toBe("auto_top_up_failed");
      expect(markFailed).toHaveBeenCalledWith({ id: autoTopUpId, failureCode: "payment_failed" });
      expect(disableAutoTopUp).toHaveBeenCalledWith({ accountId, reason: "payment_failed" });
      // Must NOT set the subscription status to past_due.
      expect(repository.rows.get(accountId)?.status).toBe("active");
      expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
      expect(noticeMailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "billing@example.com" }));
      const content = noticeMailSend.mock.calls[0][0].content;
      expect(content.paragraphs.some((p: string) => p.includes("https://invoice.stripe.com/i/atu2"))).toBe(true);
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ accountId, eventType: "billing.auto_top_up_failed" }),
      );
    });

    it("replaying an auto-top-up invoice.payment_failed event is a no-op the second time", async () => {
      const { deps, repository, markFailed } = createDeps();
      repository.rows.set(accountId, {
        accountId,
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
        priceId: null,
        interval: null,
        status: "active",
        billingEmail: null,
        currentPeriodEnd: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const autoTopUpId = randomUUID();
      const event: StripeWebhookEvent = {
        id: "evt_atu_3",
        type: "invoice.payment_failed",
        invoice: {
          id: "in_atu_3",
          customerId: "cus_1",
          metadata: { radioso_kind: "auto_top_up", account_id: accountId, auto_top_up_id: autoTopUpId },
          hostedInvoiceUrl: null,
        },
      };

      const first = await handleBillingWebhookEvent(event, deps);
      const second = await handleBillingWebhookEvent(event, deps);

      expect(first.outcome).toBe("auto_top_up_failed");
      expect(second.outcome).toBe("duplicate");
      expect(markFailed).toHaveBeenCalledTimes(1);
    });
  });
});
