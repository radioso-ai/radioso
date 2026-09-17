import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PLAN_CATALOG } from "@radioso/plan-catalog";

import type {
  BillingCustomerPatch,
  BillingCustomerRepository,
  BillingCustomerRow,
  ProcessedEventClaim,
} from "./billingCustomerRepository.js";
import { handleBillingWebhookEvent, type BillingWebhookHandlerDeps } from "./billingWebhookHandler.js";
import type { StripeWebhookEvent } from "./stripeGateway.js";

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
  mailSend: ReturnType<typeof vi.fn>;
  auditRecord: ReturnType<typeof vi.fn>;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
} => {
  const repository = new FakeBillingCustomerRepository();
  const assignProfile = vi.fn(async () => undefined);
  const addCredits = vi.fn(async () => ({ credits: 300, applied: true }));
  const getProduct = vi.fn(async (id: string) => ({ id, metadata: {} }));
  const mailSend = vi.fn(async () => undefined);
  const auditRecord = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };

  const deps: BillingWebhookHandlerDeps = {
    repository,
    usage: { assignProfile, addCredits },
    gateway: { getProduct },
    mail: { send: mailSend },
    audit: { record: auditRecord },
    logger,
    appBaseUrl: "https://app.example.com",
    ...overrides,
  };
  return { deps, repository, assignProfile, addCredits, getProduct, mailSend, auditRecord, logger };
};

const satellitePlan = PLAN_CATALOG.plans.find((plan) => plan.id === "satellite")!;
const planetPlan = PLAN_CATALOG.plans.find((plan) => plan.id === "planet")!;

describe("handleBillingWebhookEvent", () => {
  let accountId: string;

  beforeEach(() => {
    accountId = randomUUID();
  });

  it("checkout.session.completed (subscription) upserts the customer row and assigns the plan", async () => {
    const { deps, repository, assignProfile, auditRecord, getProduct } = createDeps();
    getProduct.mockResolvedValueOnce({ id: "prod_satellite", metadata: { plan: "satellite" } });

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

  it("customer.subscription.updated assigns the new plan when the price changed", async () => {
    const { deps, repository, assignProfile, getProduct } = createDeps();
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
  });

  it("customer.subscription.updated only syncs the row when the price is unchanged", async () => {
    const { deps, assignProfile } = createDeps();
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
  });

  it("customer.subscription.deleted returns the account to the catalog's default plan", async () => {
    const { deps, repository, assignProfile, auditRecord } = createDeps();
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
  });

  it("invoice.paid sets the row active and never assigns a plan", async () => {
    const { deps, repository, assignProfile } = createDeps();
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
      invoice: { id: "in_1", customerId: "cus_1" },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("active");
    expect(repository.rows.get(accountId)?.status).toBe("active");
    expect(assignProfile).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed marks past_due, emails the billing address, and never downgrades", async () => {
    const { deps, repository, mailSend, assignProfile, auditRecord } = createDeps();
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
      id: "evt_7",
      type: "invoice.payment_failed",
      invoice: { id: "in_2", customerId: "cus_1" },
    };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("payment_failed");
    expect(repository.rows.get(accountId)?.status).toBe("past_due");
    expect(assignProfile).not.toHaveBeenCalled();
    expect(mailSend).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@example.com" }));
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventType: "billing.payment_failed" }),
    );
  });

  it("invoice.payment_failed skips the email when the row has no billing address", async () => {
    const { deps, repository, mailSend } = createDeps();
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
      invoice: { id: "in_3", customerId: "cus_1" },
    };

    await handleBillingWebhookEvent(event, deps);

    expect(mailSend).not.toHaveBeenCalled();
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
      invoice: { id: "in_4", customerId: "cus_unrecognized" },
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

  it("ignores event types outside the billing table without touching the repository", async () => {
    const { deps, repository } = createDeps();
    const claimSpy = vi.spyOn(repository, "markEventProcessed");

    const event: StripeWebhookEvent = { id: "evt_12", type: "payment_intent.succeeded" };

    const result = await handleBillingWebhookEvent(event, deps);

    expect(result.outcome).toBe("ignored");
    expect(claimSpy).not.toHaveBeenCalled();
  });
});
