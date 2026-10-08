import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { createEeKysely } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import { currentPeriodStart } from "../usageLimits/period.js";
import { PostgresAutoTopUpRepository, type AutoTopUpRepository } from "./autoTopUpRepository.js";
import { PostgresBillingCustomerRepository, type BillingCustomerRepository } from "./billingCustomerRepository.js";
import { isAutoTopUpAvailable } from "./planPricing.js";
import { StripeDefinitiveChargeError, type StripeGateway } from "./stripeGateway.js";

/** Accounts fetched per keyset page while paging the enabled set. One `run()` call pages through
 *  every enabled account (see `sweepEnabledAccounts`), so this bounds query size, not how many
 *  accounts one run covers. */
const PAGE_SIZE = 200;
/** Stale pending rows re-driven per tick, bounded the same way. */
const REDRIVE_BATCH_SIZE = 50;
/** How long a gateway failure blocks a new claim for the same account, so a persistently
 *  declining card (or a Stripe outage) is not hammered every 60s tick. */
const FAILURE_COOLDOWN_MS = 60 * 60_000;
/** How long a `pending` row sits untouched before a later tick re-drives it -- long enough that
 *  an in-flight attempt (seconds) is never raced by a re-drive, short enough that a crashed or
 *  ambiguously-failed attempt resumes quickly. */
const PENDING_LEASE_MS = 5 * 60_000;

const errorCode = (error: unknown): string => {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; name?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length > 0) {
      return candidate.code;
    }
    if (typeof candidate.name === "string" && candidate.name.length > 0) {
      return candidate.name;
    }
  }
  return "unknown_error";
};

interface AutoTopUpDispatcherInput {
  database: UsageLimitDatabasePort;
  /** `undefined` when billing is unconfigured (self-hosted without Stripe) -- `run()` no-ops
   *  immediately rather than evaluating any account. */
  gateway:
    | Pick<StripeGateway, "findPriceByLookupKey" | "createTopUpInvoiceDraft" | "chargeTopUpInvoice" | "voidInvoice">
    | undefined;
  audit: {
    record(input: {
      accountId?: string | null;
      workspaceId?: string | null;
      eventType: string;
      eventStatus: "success" | "failure";
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  logger: { warn(entry: unknown, message?: string): void };
}

/**
 * The periodic sweep behind opt-in auto top-up. Each run does two things:
 *
 * 1. Re-drives every `pending` row whose `updated_at` lease has expired -- a charge this process
 *    (or an earlier one) started but never resolved, because of a crash or an ambiguous Stripe
 *    failure (network, timeout, 5xx, rate limit) where the charge's outcome is unknown. Re-driving
 *    replays the exact same idempotent Stripe call sequence (same keys, derived from the row id),
 *    so a charge Stripe already completed is recognized rather than repeated.
 * 2. Pages through every enabled account (not just the same oldest batch every tick) and, for one
 *    whose conversation usage has reached `limit_reached` or `grace_exhausted`, claims one pack
 *    this period (subject to the pending guard, the monthly cap, and the failure cooldown -- all
 *    enforced by `AutoTopUpRepository.claimPending`) and starts charging it.
 *
 * A charge is only ever marked `failed` on a definitive outcome -- a card decline or an invalid
 * request (`StripeDefinitiveChargeError`) -- never on an ambiguous one, since Stripe may have
 * already collected payment before the response was lost. The invoice id is persisted right after
 * `createTopUpInvoiceDraft` returns, before the item/finalize/pay sequence, so a crash or timeout
 * after that point still knows which invoice to resume (or void) rather than losing track of it.
 */
export class AutoTopUpDispatcher {
  private readonly usage: EnterpriseUsageLimitService;
  private readonly autoTopUps: AutoTopUpRepository;
  private readonly billingCustomers: BillingCustomerRepository;

  constructor(private readonly input: AutoTopUpDispatcherInput) {
    this.usage = new EnterpriseUsageLimitService(input.database);
    this.autoTopUps = new PostgresAutoTopUpRepository(createEeKysely(input.database.pool));
    this.billingCustomers = new PostgresBillingCustomerRepository(createEeKysely(input.database.pool));
  }

  async run(): Promise<void> {
    if (!this.input.gateway) {
      return;
    }

    await this.redriveStalePending();
    await this.sweepEnabledAccounts();
  }

  private async redriveStalePending(): Promise<void> {
    for (;;) {
      const stale = await this.autoTopUps.claimStalePending({ leaseMs: PENDING_LEASE_MS, limit: REDRIVE_BATCH_SIZE });
      if (stale.length === 0) {
        return;
      }
      for (const row of stale) {
        const billingRow = await this.billingCustomers.findByAccount(row.accountId);
        if (!billingRow?.stripeSubscriptionId) {
          // Nothing to resume against (account's billing row changed or disappeared since the
          // charge started). Leave it pending; the lease has already been bumped, so this will
          // not be picked up again until the lease next expires.
          continue;
        }
        await this.chargeClaim({
          id: row.id,
          accountId: row.accountId,
          customerId: billingRow.stripeCustomerId,
          subscriptionId: billingRow.stripeSubscriptionId,
          existingInvoiceId: row.stripeInvoiceId,
        });
      }
      if (stale.length < REDRIVE_BATCH_SIZE) {
        return;
      }
    }
  }

  private async sweepEnabledAccounts(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const accountIds = await this.autoTopUps.listEnabledAccountIds({ after, limit: PAGE_SIZE });
      if (accountIds.length === 0) {
        return;
      }
      for (const accountId of accountIds) {
        await this.processAccount(accountId);
      }
      after = accountIds[accountIds.length - 1];
      if (accountIds.length < PAGE_SIZE) {
        return;
      }
    }
  }

  private async processAccount(accountId: string): Promise<void> {
    const settings = await this.autoTopUps.getSettings(accountId);
    if (!settings?.enabled) {
      return;
    }

    const usage = await this.usage.getAccountUsage(accountId);
    const level = usage.monthlyConversations?.level;
    if (level !== "limit_reached" && level !== "grace_exhausted") {
      return;
    }

    const planId = usage.profile?.key ?? PLAN_CATALOG.defaultPlanId;
    const billingRow = await this.billingCustomers.findByAccount(accountId);
    const available = isAutoTopUpAvailable({
      planId,
      subscriptionStatus: billingRow?.status ?? "none",
      hasSubscription: Boolean(billingRow?.stripeSubscriptionId),
    });
    if (!available || !billingRow?.stripeSubscriptionId) {
      return;
    }

    const periodStart = currentPeriodStart();
    const claimedId = await this.autoTopUps.claimPending({
      accountId,
      periodStart,
      maxPacksPerMonth: settings.maxPacksPerMonth,
      cooldownMs: FAILURE_COOLDOWN_MS,
    });
    if (!claimedId) {
      return;
    }

    await this.chargeClaim({
      id: claimedId,
      accountId,
      customerId: billingRow.stripeCustomerId,
      subscriptionId: billingRow.stripeSubscriptionId,
      existingInvoiceId: null,
    });
  }

  /**
   * Drives one row's charge sequence to the point Stripe has either paid it, declined it, or left
   * it ambiguous. `existingInvoiceId` resumes a re-drive at the charge step, skipping
   * `createTopUpInvoiceDraft` entirely when a prior attempt already created (and persisted) one.
   */
  private async chargeClaim(input: {
    id: string;
    accountId: string;
    customerId: string;
    subscriptionId: string;
    existingInvoiceId: string | null;
  }): Promise<void> {
    const gateway = this.input.gateway!;
    let invoiceId = input.existingInvoiceId;
    try {
      if (!invoiceId) {
        const draft = await gateway.createTopUpInvoiceDraft({
          customerId: input.customerId,
          subscriptionId: input.subscriptionId,
          metadata: { radioso_kind: "auto_top_up", account_id: input.accountId, auto_top_up_id: input.id },
          idempotencyKey: `${input.id}:create`,
        });
        invoiceId = draft.invoiceId;
        // Persisted immediately, before the item/finalize/pay sequence below: a crash or timeout
        // from here on must still know which invoice to resume or void, never lose track of it.
        await this.autoTopUps.markInvoiceCreated({ id: input.id, stripeInvoiceId: invoiceId });
      }

      const priceRef = await gateway.findPriceByLookupKey(PLAN_CATALOG.topUp.stripeLookupKey);
      if (!priceRef) {
        throw new Error("top_up_price_not_configured");
      }

      // "paid" is resolved by the `invoice.paid` webhook (credits + markPaid); "open" (the pay
      // call did not resolve it, without throwing) leaves the row pending for a later re-drive.
      await gateway.chargeTopUpInvoice({ invoiceId, customerId: input.customerId, priceId: priceRef.id, idempotencyKey: input.id });
    } catch (error) {
      if (error instanceof StripeDefinitiveChargeError) {
        await this.failDefinitively({ id: input.id, accountId: input.accountId, invoiceId, error });
        return;
      }
      // Ambiguous (network, timeout, 5xx, rate limit, or our own "price not configured"): the
      // charge's outcome at Stripe is unknown, so the row stays pending for `redriveStalePending`
      // to retry later with the same idempotency keys.
      const code = errorCode(error);
      this.input.logger.warn(
        { accountId: input.accountId, autoTopUpId: input.id, errorCode: code },
        "Auto top-up charge attempt failed ambiguously; will re-drive",
      );
      await this.input.audit.record({
        accountId: input.accountId,
        workspaceId: null,
        eventType: "billing.auto_top_up_invoice_error",
        eventStatus: "failure",
        metadata: { autoTopUpId: input.id, errorCode: code, definitive: false },
      });
    }
  }

  private async failDefinitively(input: {
    id: string;
    accountId: string;
    invoiceId: string | null;
    error: StripeDefinitiveChargeError;
  }): Promise<void> {
    if (input.invoiceId) {
      try {
        await this.input.gateway!.voidInvoice(input.invoiceId);
      } catch {
        // Already void (a prior attempt voided it) or already paid (settled between our decline
        // and this call) -- either way there is nothing left to undo.
      }
    }
    await this.autoTopUps.markFailed({ id: input.id, failureCode: input.error.code });
    this.input.logger.warn(
      { accountId: input.accountId, autoTopUpId: input.id, errorCode: input.error.code },
      "Auto top-up charge declined",
    );
    await this.input.audit.record({
      accountId: input.accountId,
      workspaceId: null,
      eventType: "billing.auto_top_up_invoice_error",
      eventStatus: "failure",
      metadata: { autoTopUpId: input.id, errorCode: input.error.code, definitive: true },
    });
  }
}
