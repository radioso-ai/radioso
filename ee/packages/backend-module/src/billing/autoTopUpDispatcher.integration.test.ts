import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEeKysely } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import { usageLimitMigrator } from "../usageLimits/usageLimitMigrator.js";
import { currentPeriodStart } from "../usageLimits/period.js";
import { billingMigrator } from "./billingMigrator.js";
import { PostgresBillingCustomerRepository } from "./billingCustomerRepository.js";
import { PostgresAutoTopUpRepository } from "./autoTopUpRepository.js";
import { AutoTopUpDispatcher } from "./autoTopUpDispatcher.js";
import { handleBillingWebhookEvent, type BillingWebhookHandlerDeps } from "./billingWebhookHandler.js";
import { StripeDefinitiveChargeError, type StripeGateway, type StripeWebhookEvent } from "./stripeGateway.js";

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const canReachIntegrationDatabase = async (databaseUrl?: string): Promise<boolean> => {
  if (!databaseUrl) {
    return false;
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
};

class PgDatabase implements UsageLimitDatabasePort {
  constructor(readonly pool: pg.Pool) {}

  async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows as T[];
  }
}

const hasReachableIntegrationDatabase = await canReachIntegrationDatabase(integrationDatabaseUrl);
const describeIfDatabase = hasReachableIntegrationDatabase ? describe : describe.skip;

describeIfDatabase("AutoTopUpDispatcher integration", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  const schema = `ee_auto_top_up_dispatch_test_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({ connectionString: integrationDatabaseUrl!, options: `-c search_path=${schema}` });
    database = new PgDatabase(pool);

    await database.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        email_verified_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Integration Account',
        email TEXT NOT NULL DEFAULT 'integration@example.com',
        password_hash TEXT NOT NULL DEFAULT 'hash',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'Integration Workspace',
        public_route_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        content_size_bytes BIGINT,
        external_document_id TEXT,
        source_kind TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await database.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await usageLimitMigrator.migrate(database);
    await billingMigrator.migrate(database);
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end().catch(() => undefined);
    }
  });

  // `sweepEnabledAccounts` now pages through every enabled account in the schema, not just a
  // bounded recent batch -- so a prior test's still-enabled, still-eligible account would
  // otherwise get swept again by a later test's `dispatcher.run()` call and inflate its gateway
  // call counts. Each test's own settings/rows are cleared before the next one starts.
  afterEach(async () => {
    await database.query(`TRUNCATE ee_billing_auto_top_up_settings, ee_billing_auto_top_ups`);
  });

  const seedAccount = async (): Promise<string> => {
    const accountId = randomUUID();
    await database.query(`INSERT INTO accounts (id, name, email) VALUES ($1, $2, $3)`, [
      accountId,
      "Dispatcher Account",
      `auto-top-up-dispatch-${accountId}@example.com`,
    ]);
    return accountId;
  };

  // Shared across every eligible account seeded in a test (instead of one profile per account),
  // since the >200-account pagination test would otherwise spend most of its time creating profiles.
  let satelliteProfileKey: string;

  const assignCatalogProfile = async (accountId: string, planId: "satellite" | "comet"): Promise<void> => {
    const service = new EnterpriseUsageLimitService(database);
    if (planId === "comet") {
      await service.upsertProfile({
        key: "comet",
        displayName: "comet",
        monthlyAnswerLimit: null,
        storedDocumentLimit: null,
        monthlyConversationLimit: 50,
      });
      await service.assignProfile(accountId, "comet");
      return;
    }
    if (!satelliteProfileKey) {
      satelliteProfileKey = "satellite";
      await service.upsertProfile({
        key: satelliteProfileKey,
        displayName: "satellite",
        monthlyAnswerLimit: null,
        storedDocumentLimit: null,
        monthlyConversationLimit: 1000,
      });
    }
    await service.assignProfile(accountId, satelliteProfileKey);
  };

  const setUsageState = async (accountId: string, usedTenths: number, balanceTenths: number): Promise<void> => {
    const periodStart = currentPeriodStart();
    await database.query(
      `INSERT INTO ee_usage_limit_unit_counters (account_id, period_start, used_tenths) VALUES ($1, $2::date, $3)
       ON CONFLICT (account_id, period_start) DO UPDATE SET used_tenths = EXCLUDED.used_tenths`,
      [accountId, periodStart, usedTenths],
    );
    await database.query(
      `INSERT INTO ee_usage_limit_credits (account_id, balance_tenths) VALUES ($1, $2)
       ON CONFLICT (account_id) DO UPDATE SET balance_tenths = EXCLUDED.balance_tenths`,
      [accountId, balanceTenths],
    );
  };

  const seedBillingCustomer = async (
    accountId: string,
    status: "active" | "past_due" | "canceled" | "none" = "active",
  ): Promise<void> => {
    const repository = new PostgresBillingCustomerRepository(createEeKysely(pool));
    await repository.upsertCustomer({
      accountId,
      stripeCustomerId: `cus_${accountId}`,
      stripeSubscriptionId: `sub_${accountId}`,
      status,
    });
  };

  const enableAutoTopUp = async (accountId: string, maxPacksPerMonth = 3): Promise<void> => {
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    await repository.upsertSettings({ accountId, enabled: true, maxPacksPerMonth });
  };

  /** Seeds a fully eligible, at-limit, enabled account in one call, for tests that only care
   *  about the sweep's own behavior once an account is eligible. */
  const seedEligibleAccount = async (): Promise<string> => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    return accountId;
  };

  const createFakeGateway = (overrides: Partial<StripeGateway> = {}): StripeGateway =>
    ({
      findPriceByLookupKey: vi.fn(async (key: string) => ({ id: `price_${key}`, lookupKey: key, productId: "prod_topup" })),
      getProduct: vi.fn(async () => null),
      createCustomer: vi.fn(async () => ({ id: "cus_new" })),
      createCheckoutSession: vi.fn(async () => ({ url: "https://checkout.stripe.com/session/1" })),
      createPortalSession: vi.fn(async () => ({ url: "https://billing.stripe.com/portal/1" })),
      constructWebhookEvent: vi.fn(async () => {
        throw new Error("not stubbed");
      }),
      createTopUpInvoiceDraft: vi.fn(async () => ({ invoiceId: `in_${randomUUID()}` })),
      chargeTopUpInvoice: vi.fn(async () => ({ status: "paid" as const })),
      voidInvoice: vi.fn(async () => undefined),
      ...overrides,
    });

  const createDispatcher = (gateway: StripeGateway) => {
    const auditRecord = vi.fn(async () => undefined);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const dispatcher = new AutoTopUpDispatcher({
      database,
      gateway,
      audit: { record: auditRecord },
      logger,
    });
    return { dispatcher, auditRecord, logger };
  };

  const readRows = async (
    accountId: string,
  ): Promise<Array<{ id: string; status: string; failure_code: string | null; stripe_invoice_id: string | null }>> => {
    return database.query<{ id: string; status: string; failure_code: string | null; stripe_invoice_id: string | null }>(
      `SELECT id, status, failure_code, stripe_invoice_id FROM ee_billing_auto_top_ups WHERE account_id = $1`,
      [accountId],
    );
  };

  const ageRow = async (id: string, age: string): Promise<void> => {
    await database.query(`UPDATE ee_billing_auto_top_ups SET updated_at = now() - interval '${age}' WHERE id = $1`, [id]);
  };

  /** Fires the auto-top-up webhook path directly against the real repositories, for tests that
   *  need to see both the dispatcher's and the webhook's side of one row's lifecycle. */
  const fireAutoTopUpWebhookEvent = async (
    event: StripeWebhookEvent,
    gateway: StripeGateway,
    overrides: Partial<BillingWebhookHandlerDeps> = {},
  ): Promise<{ addCredits: ReturnType<typeof vi.fn>; disableSpy: ReturnType<typeof vi.fn>; noticeMailSend: ReturnType<typeof vi.fn> }> => {
    const billingRepository = new PostgresBillingCustomerRepository(createEeKysely(pool));
    const autoTopUpRepository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const addCredits = vi.fn(async () => ({ credits: 300, applied: true }));
    const disableSpy = vi.fn(autoTopUpRepository.disable.bind(autoTopUpRepository));
    const noticeMailSend = vi.fn(async () => ({ dispatched: true }));
    await handleBillingWebhookEvent(event, {
      repository: billingRepository,
      usage: { assignProfile: vi.fn(async () => undefined), addCredits },
      gateway,
      autoTopUps: {
        findById: autoTopUpRepository.findById.bind(autoTopUpRepository),
        markPaid: autoTopUpRepository.markPaid.bind(autoTopUpRepository),
        markFailed: autoTopUpRepository.markFailed.bind(autoTopUpRepository),
        disable: disableSpy,
      },
      noticeMail: { send: noticeMailSend },
      accountAdministrators: { list: vi.fn(async () => [{ email: "owner@example.com", displayName: "Owner" }]) },
      audit: { record: vi.fn(async () => undefined) },
      logger: { info: vi.fn(), warn: vi.fn() },
      appBaseUrl: "https://app.example.com",
      ...overrides,
    });
    return { addCredits, disableSpy, noticeMailSend };
  };

  it("triggers exactly once when enabled and usage is limit_reached", async () => {
    const accountId = await seedEligibleAccount();
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
    expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(1);
    const rows = await readRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].stripe_invoice_id).not.toBeNull();
  });

  it("triggers when usage is grace_exhausted", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    // 1000-conversation limit, 10% grace = 100; borrow past it entirely.
    await setUsageState(accountId, 10000, -1010);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an account under its limit", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
    expect(await readRows(accountId)).toHaveLength(0);
  });

  it("does nothing when auto top-up is not enabled", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    // never enabled
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
  });

  it("does nothing for a plan that does not sell top-ups (comet, CFO-approved 2026-09-15)", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "comet");
    await setUsageState(accountId, 500, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
  });

  it("does nothing for a past_due subscription", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId, "past_due");
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
  });

  it("does nothing for a canceled subscription", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId, "canceled");
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
  });

  it("respects the monthly cap", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId, 1);
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const existing = await repository.claimPending({
      accountId,
      periodStart: currentPeriodStart(),
      maxPacksPerMonth: 5,
      cooldownMs: 0,
    });
    await repository.markPaid(existing!);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
  });

  it("respects the pending guard: two concurrent sweeps create only one invoice", async () => {
    const accountId = await seedEligibleAccount();
    const gateway = createFakeGateway();
    const first = createDispatcher(gateway);
    const second = createDispatcher(gateway);

    await Promise.all([first.dispatcher.run(), second.dispatcher.run()]);

    expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
    expect(await readRows(accountId)).toHaveLength(1);
  });

  it("respects the 1-hour failure cooldown", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    await database.query(
      `INSERT INTO ee_billing_auto_top_ups (id, account_id, period_start, status, failure_code, created_at)
       VALUES ($1, $2, $3::date, 'failed', 'gateway_error', now())`,
      [randomUUID(), accountId, currentPeriodStart()],
    );
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoiceDraft).not.toHaveBeenCalled();
  });

  describe("exactly-once charging", () => {
    it("an ambiguous failure after the invoice was created leaves the row pending, and a later re-drive produces exactly one invoice and one grant", async () => {
      const accountId = await seedEligibleAccount();
      let chargeAttempts = 0;
      const gateway = createFakeGateway({
        chargeTopUpInvoice: vi.fn(async () => {
          chargeAttempts += 1;
          if (chargeAttempts === 1) {
            // Simulates a timeout/connection drop AFTER Stripe may have already charged the card --
            // an ambiguous outcome, never a definitive decline.
            throw new Error("socket hang up");
          }
          return { status: "paid" as const };
        }),
      });
      const { dispatcher, logger } = createDispatcher(gateway);

      await dispatcher.run();

      expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
      expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(1);
      let rows = await readRows(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending");
      const invoiceId = rows[0].stripe_invoice_id!;
      expect(invoiceId).not.toBeNull();
      // Never marked failed on an ambiguous error.
      expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("re-drive"));

      // A fresh sweep tick does nothing new -- the row is still inside its lease.
      await dispatcher.run();
      expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
      expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(1);

      // The lease expires; a later tick re-drives it with the SAME invoice id, never a second one.
      await ageRow(rows[0].id, "10 minutes");
      await dispatcher.run();

      expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
      expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(2);
      expect(gateway.chargeTopUpInvoice).toHaveBeenNthCalledWith(2, expect.objectContaining({ invoiceId }));
      rows = await readRows(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].stripe_invoice_id).toBe(invoiceId);

      // Stripe's own `invoice.paid` webhook resolves the still-pending row -- exactly one grant.
      const { addCredits } = await fireAutoTopUpWebhookEvent(
        {
          id: "evt_paid_1",
          type: "invoice.paid",
          invoice: {
            id: invoiceId,
            customerId: `cus_${accountId}`,
            metadata: { radioso_kind: "auto_top_up", account_id: accountId, auto_top_up_id: rows[0].id },
            hostedInvoiceUrl: null,
          },
        },
        gateway,
      );
      expect(addCredits).toHaveBeenCalledTimes(1);
      expect((await readRows(accountId))[0].status).toBe("paid");
    });

    it("re-drives a row that crashed right after the claim, before any Stripe call", async () => {
      const accountId = await seedEligibleAccount();
      const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      // Simulates the process crashing immediately after `claimPending`, before `chargeClaim`
      // ever ran -- no invoice id was ever persisted.
      const id = await repository.claimPending({
        accountId,
        periodStart: currentPeriodStart(),
        maxPacksPerMonth: 3,
        cooldownMs: 0,
      });
      expect(id).not.toBeNull();
      await ageRow(id!, "10 minutes");

      const gateway = createFakeGateway();
      const { dispatcher } = createDispatcher(gateway);

      await dispatcher.run();

      expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
      expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(1);
      const rows = await readRows(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
      expect(rows[0].stripe_invoice_id).not.toBeNull();
    });

    it("a decline voids the invoice, marks the row failed, and disables auto top-up immediately", async () => {
      const accountId = await seedEligibleAccount();
      const gateway = createFakeGateway({
        chargeTopUpInvoice: vi.fn(async () => {
          throw new StripeDefinitiveChargeError("Your card was declined.", "card_declined");
        }),
      });
      const { dispatcher, auditRecord } = createDispatcher(gateway);

      await dispatcher.run();

      const rows = await readRows(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].failure_code).toBe("card_declined");
      expect(gateway.voidInvoice).toHaveBeenCalledWith(rows[0].stripe_invoice_id);
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ accountId, eventType: "billing.auto_top_up_invoice_error", eventStatus: "failure" }),
      );
      // The dispatcher itself disables on a definitive decline -- it does not wait for the
      // asynchronous webhook, since no further charge should be attempted either way.
      const settingsRepository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      expect((await settingsRepository.getSettings(accountId))?.enabled).toBe(false);

      // Stripe's own `invoice.payment_failed` webhook still arrives after the row is already
      // `failed`; `markFailed`'s atomic transition reports no change, so this is a pure no-op --
      // no second disable call, no duplicate email, no (further) void attempt.
      const { disableSpy, noticeMailSend } = await fireAutoTopUpWebhookEvent(
        {
          id: "evt_failed_1",
          type: "invoice.payment_failed",
          invoice: {
            id: rows[0].stripe_invoice_id!,
            customerId: `cus_${accountId}`,
            metadata: { radioso_kind: "auto_top_up", account_id: accountId, auto_top_up_id: rows[0].id },
            hostedInvoiceUrl: null,
          },
        },
        createFakeGateway({
          voidInvoice: vi.fn(async () => {
            throw new Error("Invoice is already void");
          }),
        }),
      );
      expect(disableSpy).not.toHaveBeenCalled();
      expect(noticeMailSend).not.toHaveBeenCalled();
      expect((await settingsRepository.getSettings(accountId))?.enabled).toBe(false);
    });

    it("an item created by a partial-success attempt (response lost) is not duplicated by a re-drive", async () => {
      const accountId = await seedEligibleAccount();
      let chargeAttempts = 0;
      let seenInvoiceId: string | null = null;
      const gateway = createFakeGateway({
        chargeTopUpInvoice: vi.fn(async (params: { invoiceId: string }) => {
          chargeAttempts += 1;
          seenInvoiceId = params.invoiceId;
          if (chargeAttempts === 1) {
            // The item step succeeded at Stripe, but the response never reached us -- an
            // ambiguous failure, same as a dropped connection.
            throw new Error("socket hang up after item create");
          }
          return { status: "paid" as const };
        }),
      });
      const { dispatcher } = createDispatcher(gateway);

      await dispatcher.run();
      const rows = await readRows(accountId);
      await ageRow(rows[0].id, "10 minutes");
      await dispatcher.run();

      expect(gateway.createTopUpInvoiceDraft).toHaveBeenCalledTimes(1);
      expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(2);
      expect(seenInvoiceId).not.toBeNull();
      // The real state-based guard lives in `stripeSdkGateway.ts` (checked against Stripe's own
      // invoice lines before calling `invoiceItems.create` again); this test's fake gateway
      // models the ambiguous-failure-then-redrive shape the dispatcher must tolerate, while
      // `chargeTopUpInvoice`'s own unit coverage is the Stripe-call-shape contract.
      const finalRows = await readRows(accountId);
      expect(finalRows).toHaveLength(1);
      expect(finalRows[0].stripe_invoice_id).toBe(seenInvoiceId);
    });

    it("gives up on a pending pack past the 20h re-drive window: voids and fails it without disabling", async () => {
      const accountId = await seedEligibleAccount();
      const gateway = createFakeGateway();
      const firstRun = createDispatcher(gateway);
      await firstRun.dispatcher.run();
      const rows = await readRows(accountId);
      expect(rows).toHaveLength(1);
      await database.query(
        `UPDATE ee_billing_auto_top_ups SET created_at = now() - interval '21 hours', updated_at = now() - interval '21 hours' WHERE id = $1`,
        [rows[0].id],
      );

      const { dispatcher: secondRunDispatcher, auditRecord } = createDispatcher(gateway);
      await secondRunDispatcher.run();

      const afterExpiry = await readRows(accountId);
      expect(afterExpiry).toHaveLength(1);
      expect(afterExpiry[0].status).toBe("failed");
      expect(afterExpiry[0].failure_code).toBe("redrive_window_expired");
      expect(gateway.voidInvoice).toHaveBeenCalledWith(rows[0].stripe_invoice_id);
      // Never re-driven: exactly the one charge attempt from the first run.
      expect(gateway.chargeTopUpInvoice).toHaveBeenCalledTimes(1);
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
          eventType: "billing.auto_top_up_invoice_error",
          metadata: expect.objectContaining({ errorCode: "redrive_window_expired" }),
        }),
      );
      // Giving up is us, not Stripe, declining -- auto top-up stays on.
      const settingsRepository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      expect((await settingsRepository.getSettings(accountId))?.enabled).toBe(true);
    });

    it("treats an invalid-request error from draft creation (e.g. a deleted subscription) as definitive: fails and disables", async () => {
      const accountId = await seedEligibleAccount();
      const gateway = createFakeGateway({
        createTopUpInvoiceDraft: vi.fn(async () => {
          throw new StripeDefinitiveChargeError("No such subscription", "resource_missing");
        }),
      });
      const { dispatcher, auditRecord } = createDispatcher(gateway);

      await dispatcher.run();

      const rows = await readRows(accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].failure_code).toBe("resource_missing");
      // No invoice was ever created, so there is nothing to void.
      expect(gateway.voidInvoice).not.toHaveBeenCalled();
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ accountId, eventType: "billing.auto_top_up_invoice_error", eventStatus: "failure" }),
      );
      const settingsRepository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      expect((await settingsRepository.getSettings(accountId))?.enabled).toBe(false);
    });
  });

  describe("pagination", () => {
    it("sweeps every enabled account, not just the first page, when there are more than 200", async () => {
      const total = 210;
      const accountIds: string[] = [];
      for (let i = 0; i < total; i += 1) {
        accountIds.push(await seedEligibleAccount());
      }

      const chargedAccountIds: string[] = [];
      const gateway = createFakeGateway({
        createTopUpInvoiceDraft: vi.fn(async (params: { metadata: Record<string, string> }) => {
          chargedAccountIds.push(params.metadata.account_id);
          return { invoiceId: `in_${randomUUID()}` };
        }),
      });
      const { dispatcher } = createDispatcher(gateway);

      await dispatcher.run();

      expect(chargedAccountIds).toHaveLength(total);
      for (const accountId of accountIds) {
        expect(chargedAccountIds).toContain(accountId);
      }
    }, 60_000);
  });
});
