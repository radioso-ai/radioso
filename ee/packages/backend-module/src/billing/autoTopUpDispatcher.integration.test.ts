import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createEeKysely } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { EnterpriseUsageLimitService } from "../usageLimits/usageLimitService.js";
import { usageLimitMigrator } from "../usageLimits/usageLimitMigrator.js";
import { currentPeriodStart } from "../usageLimits/period.js";
import { billingMigrator } from "./billingMigrator.js";
import { PostgresBillingCustomerRepository } from "./billingCustomerRepository.js";
import { PostgresAutoTopUpRepository } from "./autoTopUpRepository.js";
import { AutoTopUpDispatcher } from "./autoTopUpDispatcher.js";
import type { StripeGateway } from "./stripeGateway.js";

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

  const seedAccount = async (): Promise<string> => {
    const accountId = randomUUID();
    await database.query(`INSERT INTO accounts (id, name, email) VALUES ($1, $2, $3)`, [
      accountId,
      "Dispatcher Account",
      `auto-top-up-dispatch-${accountId}@example.com`,
    ]);
    return accountId;
  };

  const assignCatalogProfile = async (accountId: string, planId: "satellite" | "comet"): Promise<void> => {
    const service = new EnterpriseUsageLimitService(database);
    await service.upsertProfile({
      key: planId,
      displayName: planId,
      monthlyAnswerLimit: null,
      storedDocumentLimit: null,
      monthlyConversationLimit: planId === "satellite" ? 1000 : 50,
    });
    await service.assignProfile(accountId, planId);
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
      createTopUpInvoice: vi.fn(async () => ({ invoiceId: `in_${randomUUID()}` })),
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

  const readRows = async (accountId: string): Promise<Array<{ status: string; failure_code: string | null; stripe_invoice_id: string | null }>> => {
    return database.query<{ status: string; failure_code: string | null; stripe_invoice_id: string | null }>(
      `SELECT status, failure_code, stripe_invoice_id FROM ee_billing_auto_top_ups WHERE account_id = $1`,
      [accountId],
    );
  };

  it("triggers exactly once when enabled and usage is limit_reached", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const { dispatcher } = createDispatcher(gateway);

    await dispatcher.run();

    expect(gateway.createTopUpInvoice).toHaveBeenCalledTimes(1);
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

    expect(gateway.createTopUpInvoice).toHaveBeenCalledTimes(1);
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
  });

  it("respects the pending guard: two concurrent sweeps create only one invoice", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway();
    const first = createDispatcher(gateway);
    const second = createDispatcher(gateway);

    await Promise.all([first.dispatcher.run(), second.dispatcher.run()]);

    expect(gateway.createTopUpInvoice).toHaveBeenCalledTimes(1);
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

    expect(gateway.createTopUpInvoice).not.toHaveBeenCalled();
  });

  it("marks the row failed with a code on a gateway error", async () => {
    const accountId = await seedAccount();
    await assignCatalogProfile(accountId, "satellite");
    await setUsageState(accountId, 10000, 0);
    await seedBillingCustomer(accountId);
    await enableAutoTopUp(accountId);
    const gateway = createFakeGateway({
      createTopUpInvoice: vi.fn(async () => {
        throw Object.assign(new Error("card declined"), { code: "card_declined" });
      }),
    });
    const { dispatcher, auditRecord } = createDispatcher(gateway);

    await dispatcher.run();

    const rows = await readRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].failure_code).toBe("card_declined");
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, eventType: "billing.auto_top_up_invoice_error", eventStatus: "failure" }),
    );
  });
});
