import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEeKysely } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { billingMigrator } from "./billingMigrator.js";
import { PostgresBillingCustomerRepository } from "./billingCustomerRepository.js";

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

describeIfDatabase("EE billing customer repository + migrator integration", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  // Isolated schema per run, mirroring `usageLimitService.integration.test.ts`, so this suite
  // never collides with the shared ci:local test database's `public` schema.
  const schema = `ee_billing_test_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: integrationDatabaseUrl! });
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
    } finally {
      await admin.end().catch(() => undefined);
    }
    pool = new pg.Pool({
      connectionString: integrationDatabaseUrl!,
      options: `-c search_path=${schema}`,
    });
    database = new PgDatabase(pool);

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
    await database.query(
      `INSERT INTO accounts (id, name, email) VALUES ($1, $2, $3)`,
      [accountId, "Billing Integration Account", `billing-${accountId}@example.com`],
    );
    return accountId;
  };

  it("migrating twice is a no-op", async () => {
    await expect(billingMigrator.migrate(database)).resolves.toBeUndefined();
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'ee_billing_%'`,
      [schema],
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "ee_billing_customers",
      "ee_billing_processed_events",
    ]);
  });

  it("upsertCustomer inserts, then patches only the fields explicitly named", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresBillingCustomerRepository(createEeKysely(pool));

    const created = await repository.upsertCustomer({
      accountId,
      stripeCustomerId: `cus_${accountId}`,
      priceId: "price_satellite_month",
      interval: "month",
      status: "active",
      billingEmail: "owner@example.com",
    });
    expect(created.status).toBe("active");
    expect(created.priceId).toBe("price_satellite_month");
    expect(created.billingEmail).toBe("owner@example.com");

    // A status-only patch (mirrors invoice.payment_failed) must not touch price_id, interval,
    // or billing_email -- the "partial-update reset bug" this repository is written to avoid.
    const patched = await repository.upsertCustomer({
      accountId,
      stripeCustomerId: `cus_${accountId}`,
      status: "past_due",
    });
    expect(patched.status).toBe("past_due");
    expect(patched.priceId).toBe("price_satellite_month");
    expect(patched.interval).toBe("month");
    expect(patched.billingEmail).toBe("owner@example.com");
  });

  it("findByAccount and findByStripeCustomer resolve the same row", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresBillingCustomerRepository(createEeKysely(pool));
    const stripeCustomerId = `cus_${accountId}`;
    await repository.upsertCustomer({ accountId, stripeCustomerId });

    expect((await repository.findByAccount(accountId))?.stripeCustomerId).toBe(stripeCustomerId);
    expect((await repository.findByStripeCustomer(stripeCustomerId))?.accountId).toBe(accountId);
    expect(await repository.findByAccount(randomUUID())).toBeNull();
    expect(await repository.findByStripeCustomer("cus_unknown")).toBeNull();
  });

  it("markEventProcessed returns true once and false on replay", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresBillingCustomerRepository(createEeKysely(pool));
    const eventId = `evt_${randomUUID()}`;

    const first = await repository.markEventProcessed({
      eventId,
      eventType: "invoice.paid",
      accountId,
      outcome: "active",
    });
    const second = await repository.markEventProcessed({
      eventId,
      eventType: "invoice.paid",
      accountId,
      outcome: "active",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("withTransaction rolls back a claim when a later write in the same callback throws", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresBillingCustomerRepository(createEeKysely(pool));
    const eventId = `evt_${randomUUID()}`;

    await expect(
      repository.withTransaction(async (tx) => {
        await tx.markEventProcessed({ eventId, eventType: "invoice.paid", accountId, outcome: "active" });
        throw new Error("simulated failure after claiming the event");
      }),
    ).rejects.toThrow("simulated failure");

    // The rolled-back claim must not have persisted -- a retry can claim the same event id again.
    const retryClaimed = await repository.markEventProcessed({
      eventId,
      eventType: "invoice.paid",
      accountId,
      outcome: "active",
    });
    expect(retryClaimed).toBe(true);
  });
});
