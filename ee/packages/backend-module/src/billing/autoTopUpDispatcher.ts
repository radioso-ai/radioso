import { PLAN_CATALOG } from "@radioso/plan-catalog";

import { createEeKysely } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import { currentPeriodStart } from "../usageLimits/period.js";
import { PostgresAutoTopUpRepository, type AutoTopUpRepository } from "./autoTopUpRepository.js";
import { PostgresBillingCustomerRepository, type BillingCustomerRepository } from "./billingCustomerRepository.js";
import { isAutoTopUpAvailable } from "./planPricing.js";
import type { StripeGateway } from "./stripeGateway.js";

/** Accounts swept per tick, bounded for the same reason `UsageLimitAlertDispatcher` bounds its
 *  batch: a large enabled set is worked over several ticks rather than monopolizing one run. Auto
 *  top-up is opt-in and rare relative to every account on a plan, so this ceiling is generous. */
const SWEEP_BATCH_SIZE = 200;
/** How long a gateway failure blocks a retry for the same account, so a persistently declining
 *  card (or a Stripe outage) is not hammered every 60s tick. */
const FAILURE_COOLDOWN_MS = 60 * 60_000;

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
  gateway: Pick<StripeGateway, "findPriceByLookupKey" | "createTopUpInvoice"> | undefined;
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
 * The periodic sweep behind opt-in auto top-up: for every enabled account whose conversation
 * usage has reached `limit_reached` or `grace_exhausted`, claims one pack this period (subject to
 * the pending guard, the monthly cap, and the failure cooldown -- all enforced by
 * `AutoTopUpRepository.claimPending`) and charges it through Stripe. The row stays `pending`
 * after a successful charge attempt; the webhook flips it to `paid` or `failed` once Stripe
 * resolves the invoice. A gateway error here (not a declined charge -- those resolve later via
 * the webhook) marks the row failed immediately, so the cooldown applies to API/network failures
 * too.
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

    const accountIds = await this.autoTopUps.listEnabledAccountIds(SWEEP_BATCH_SIZE);
    for (const accountId of accountIds) {
      await this.processAccount(accountId);
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
    });
  }

  private async chargeClaim(input: {
    id: string;
    accountId: string;
    customerId: string;
    subscriptionId: string;
  }): Promise<void> {
    const gateway = this.input.gateway!;
    try {
      const priceRef = await gateway.findPriceByLookupKey(PLAN_CATALOG.topUp.stripeLookupKey);
      if (!priceRef) {
        throw new Error("top_up_price_not_configured");
      }

      const result = await gateway.createTopUpInvoice({
        customerId: input.customerId,
        subscriptionId: input.subscriptionId,
        priceId: priceRef.id,
        metadata: { radioso_kind: "auto_top_up", account_id: input.accountId, auto_top_up_id: input.id },
        idempotencyKey: input.id,
      });
      await this.autoTopUps.markInvoiceCreated({ id: input.id, stripeInvoiceId: result.invoiceId });
    } catch (error) {
      const code = errorCode(error);
      await this.autoTopUps.markFailed({ id: input.id, failureCode: code });
      this.input.logger.warn({ accountId: input.accountId, autoTopUpId: input.id, errorCode: code }, "Auto top-up invoice creation failed");
      await this.input.audit.record({
        accountId: input.accountId,
        workspaceId: null,
        eventType: "billing.auto_top_up_invoice_error",
        eventStatus: "failure",
        metadata: { autoTopUpId: input.id, errorCode: code },
      });
    }
  }
}
