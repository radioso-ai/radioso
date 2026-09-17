import { type Kysely, type Transaction, sql } from "kysely";

import type { EeDatabase, EeDb } from "../db/eeSchema.js";
import type { BillingInterval, BillingSubscriptionStatus } from "./planPricing.js";

export interface BillingCustomerRow {
  accountId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  priceId: string | null;
  interval: BillingInterval | null;
  status: BillingSubscriptionStatus;
  billingEmail: string | null;
  currentPeriodEnd: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A field is written on conflict only when the caller's patch explicitly names it (checked with
 * `hasOwnProperty`, not `!== undefined`) — an omitted key preserves the existing column, matching
 * the same source-gated merge convention `usageLimitRoutes.ts` uses for profile updates. Without
 * this, a status-only patch from `invoice.paid` would null out `price_id` / `interval` on every
 * other row.
 */
export interface BillingCustomerPatch {
  accountId: string;
  stripeCustomerId: string;
  stripeSubscriptionId?: string | null;
  priceId?: string | null;
  interval?: BillingInterval | null;
  status?: BillingSubscriptionStatus;
  billingEmail?: string | null;
  currentPeriodEnd?: Date | null;
}

export interface ProcessedEventClaim {
  eventId: string;
  eventType: string;
  accountId: string | null;
  outcome: string;
}

export interface BillingCustomerRepository {
  findByAccount(accountId: string): Promise<BillingCustomerRow | null>;
  findByStripeCustomer(stripeCustomerId: string): Promise<BillingCustomerRow | null>;
  upsertCustomer(patch: BillingCustomerPatch): Promise<BillingCustomerRow>;
  /** Inserts the idempotency marker. Returns `false` (no side effects should run) when an event
   *  with this id was already claimed; `true` otherwise. */
  markEventProcessed(claim: ProcessedEventClaim): Promise<boolean>;
  /** Runs `callback` against a transactional repository. A failure inside `callback` rolls back
   *  everything written through it, including a prior `markEventProcessed` claim in the same
   *  callback — so a failed webhook attempt leaves nothing behind for Stripe's retry to collide
   *  with. */
  withTransaction<T>(callback: (tx: BillingCustomerRepository) => Promise<T>): Promise<T>;
}

const mapRow = (row: {
  account_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  price_id: string | null;
  interval: string | null;
  status: string;
  billing_email: string | null;
  current_period_end: Date | null;
  created_at: Date;
  updated_at: Date;
}): BillingCustomerRow => ({
  accountId: row.account_id,
  stripeCustomerId: row.stripe_customer_id,
  stripeSubscriptionId: row.stripe_subscription_id,
  priceId: row.price_id,
  interval: row.interval as BillingInterval | null,
  status: row.status as BillingSubscriptionStatus,
  billingEmail: row.billing_email,
  currentPeriodEnd: row.current_period_end,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const selectColumns = [
  "account_id",
  "stripe_customer_id",
  "stripe_subscription_id",
  "price_id",
  "interval",
  "status",
  "billing_email",
  "current_period_end",
  "created_at",
  "updated_at",
] as const;

export class PostgresBillingCustomerRepository implements BillingCustomerRepository {
  constructor(private readonly db: EeDb) {}

  async findByAccount(accountId: string): Promise<BillingCustomerRow | null> {
    const row = await this.db
      .selectFrom("ee_billing_customers")
      .select(selectColumns)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async findByStripeCustomer(stripeCustomerId: string): Promise<BillingCustomerRow | null> {
    const row = await this.db
      .selectFrom("ee_billing_customers")
      .select(selectColumns)
      .where("stripe_customer_id", "=", stripeCustomerId)
      .executeTakeFirst();
    return row ? mapRow(row) : null;
  }

  async upsertCustomer(patch: BillingCustomerPatch): Promise<BillingCustomerRow> {
    const hasOwn = (key: keyof BillingCustomerPatch): boolean =>
      Object.prototype.hasOwnProperty.call(patch, key);

    await this.db
      .insertInto("ee_billing_customers")
      .values({
        account_id: patch.accountId,
        stripe_customer_id: patch.stripeCustomerId,
        stripe_subscription_id: patch.stripeSubscriptionId ?? null,
        price_id: patch.priceId ?? null,
        interval: patch.interval ?? null,
        status: patch.status ?? "none",
        billing_email: patch.billingEmail ?? null,
        current_period_end: patch.currentPeriodEnd ?? null,
      })
      .onConflict((oc) =>
        oc.column("account_id").doUpdateSet({
          stripe_customer_id: (eb) => eb.ref("excluded.stripe_customer_id"),
          ...(hasOwn("stripeSubscriptionId")
            ? { stripe_subscription_id: (eb) => eb.ref("excluded.stripe_subscription_id") }
            : {}),
          ...(hasOwn("priceId") ? { price_id: (eb) => eb.ref("excluded.price_id") } : {}),
          ...(hasOwn("interval") ? { interval: (eb) => eb.ref("excluded.interval") } : {}),
          ...(hasOwn("status") ? { status: (eb) => eb.ref("excluded.status") } : {}),
          ...(hasOwn("billingEmail") ? { billing_email: (eb) => eb.ref("excluded.billing_email") } : {}),
          ...(hasOwn("currentPeriodEnd")
            ? { current_period_end: (eb) => eb.ref("excluded.current_period_end") }
            : {}),
          updated_at: sql<Date>`now()`,
        }),
      )
      .execute();

    const row = await this.findByAccount(patch.accountId);
    if (!row) {
      throw new Error("upsertCustomer: row missing immediately after upsert");
    }
    return row;
  }

  async markEventProcessed(claim: ProcessedEventClaim): Promise<boolean> {
    const inserted = await this.db
      .insertInto("ee_billing_processed_events")
      .values({
        event_id: claim.eventId,
        event_type: claim.eventType,
        account_id: claim.accountId,
        outcome: claim.outcome,
      })
      .onConflict((oc) => oc.column("event_id").doNothing())
      .returning("event_id")
      .executeTakeFirst();
    return Boolean(inserted);
  }

  async withTransaction<T>(callback: (tx: BillingCustomerRepository) => Promise<T>): Promise<T> {
    const root = this.db as Kysely<EeDatabase>;
    return root.transaction().execute((trx: Transaction<EeDatabase>) =>
      callback(new PostgresBillingCustomerRepository(trx)));
  }
}
