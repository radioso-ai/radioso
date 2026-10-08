import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createEeKysely } from "../db/eeSchema.js";
import type { UsageLimitDatabasePort } from "../radiosoModuleTypes.js";
import { billingMigrator } from "./billingMigrator.js";
import { PostgresAutoTopUpRepository } from "./autoTopUpRepository.js";

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

describeIfDatabase("EE auto top-up repository + migrator integration", () => {
  let pool: pg.Pool;
  let database: PgDatabase;
  // Isolated schema per run, mirroring `billingCustomerRepository.integration.test.ts`, so this
  // suite never collides with -- or leaves rows behind for -- any other integration test file
  // sharing the same database.
  const schema = `ee_auto_top_up_test_${randomUUID().replace(/-/g, "")}`;

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
    await database.query(`INSERT INTO accounts (id, name, email) VALUES ($1, $2, $3)`, [
      accountId,
      "Auto Top-Up Integration Account",
      `auto-top-up-${accountId}@example.com`,
    ]);
    return accountId;
  };

  const periodStart = "2026-10-01";

  const insertFailedAt = async (accountId: string, createdAt: Date): Promise<void> => {
    await database.query(
      `INSERT INTO ee_billing_auto_top_ups (id, account_id, period_start, status, failure_code, created_at)
       VALUES ($1, $2, $3::date, 'failed', 'gateway_error', $4)`,
      [randomUUID(), accountId, periodStart, createdAt],
    );
  };

  it("migrating twice is a no-op and leaves exactly the expected tables", async () => {
    await expect(billingMigrator.migrate(database)).resolves.toBeUndefined();
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'ee_billing_%'`,
      [schema],
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual([
      "ee_billing_auto_top_up_settings",
      "ee_billing_auto_top_ups",
      "ee_billing_customers",
      "ee_billing_processed_events",
    ]);
  });

  it("upsertSettings inserts, then patches only the fields explicitly named", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));

    const created = await repository.upsertSettings({ accountId, enabled: true, maxPacksPerMonth: 3 });
    expect(created.enabled).toBe(true);
    expect(created.maxPacksPerMonth).toBe(3);
    expect(created.disabledReason).toBeNull();

    await repository.disable({ accountId, reason: "payment_failed" });
    const afterFailure = await repository.getSettings(accountId);
    expect(afterFailure?.enabled).toBe(false);
    expect(afterFailure?.disabledReason).toBe("payment_failed");
    expect(afterFailure?.disabledAt).not.toBeNull();
    // disable() must not touch the cap -- a re-enable should see the same value the operator set.
    expect(afterFailure?.maxPacksPerMonth).toBe(3);

    // Re-enabling clears disabledReason/disabledAt, matching the route's own contract, without
    // the caller having to re-send maxPacksPerMonth.
    const reEnabled = await repository.upsertSettings({ accountId, enabled: true, disabledReason: null, disabledAt: null });
    expect(reEnabled.enabled).toBe(true);
    expect(reEnabled.disabledReason).toBeNull();
    expect(reEnabled.disabledAt).toBeNull();
    expect(reEnabled.maxPacksPerMonth).toBe(3);
  });

  it("getSettings returns null for an account with no row", async () => {
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    expect(await repository.getSettings(randomUUID())).toBeNull();
  });

  it("listEnabledAccountIds returns only enabled accounts, bounded by limit", async () => {
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const enabledA = await seedAccount();
    const enabledB = await seedAccount();
    const disabled = await seedAccount();
    await repository.upsertSettings({ accountId: enabledA, enabled: true, maxPacksPerMonth: 3 });
    await repository.upsertSettings({ accountId: enabledB, enabled: true, maxPacksPerMonth: 3 });
    await repository.upsertSettings({ accountId: disabled, enabled: false, maxPacksPerMonth: 3 });

    const ids = await repository.listEnabledAccountIds({ after: null, limit: 1000 });
    expect(ids).toContain(enabledA);
    expect(ids).toContain(enabledB);
    expect(ids).not.toContain(disabled);

    const bounded = await repository.listEnabledAccountIds({ after: null, limit: 0 });
    expect(bounded).toHaveLength(0);
  });

  it("listEnabledAccountIds pages through every enabled account with a keyset cursor, in a stable order", async () => {
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const accountIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const accountId = await seedAccount();
      await repository.upsertSettings({ accountId, enabled: true, maxPacksPerMonth: 3 });
      accountIds.push(accountId);
    }

    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await repository.listEnabledAccountIds({ after, limit: 7 });
      if (page.length === 0) break;
      seen.push(...page);
      after = page[page.length - 1];
      if (page.length < 7) break;
    }

    for (const accountId of accountIds) {
      expect(seen).toContain(accountId);
    }
    // No account ever repeats across pages, and the full page count matches every account the
    // cursor walked past -- a page is never re-served once its cursor has advanced beyond it.
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("countForPeriod counts pending and paid rows, not failed, scoped to the period", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    await insertFailedAt(accountId, new Date());

    expect(await repository.countForPeriod(accountId, periodStart)).toBe(0);

    const claimed = await repository.claimPending({
      accountId,
      periodStart,
      maxPacksPerMonth: 5,
      cooldownMs: 0,
    });
    expect(claimed).not.toBeNull();
    expect(await repository.countForPeriod(accountId, periodStart)).toBe(1);

    await repository.markPaid(claimed!);
    expect(await repository.countForPeriod(accountId, periodStart)).toBe(1);
  });

  it("claimPending returns null when a pending row already exists (the pending guard)", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));

    const first = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
    expect(first).not.toBeNull();

    const second = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
    expect(second).toBeNull();
  });

  it("claimPending returns null once pending+paid rows reach the monthly cap", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));

    const first = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 1, cooldownMs: 0 });
    expect(first).not.toBeNull();
    await repository.markPaid(first!);

    const second = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 1, cooldownMs: 0 });
    expect(second).toBeNull();
  });

  it("claimPending returns null inside the failure cooldown, and an id once it elapses", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    await insertFailedAt(accountId, new Date());

    const withinCooldown = await repository.claimPending({
      accountId,
      periodStart,
      maxPacksPerMonth: 5,
      cooldownMs: 60 * 60_000,
    });
    expect(withinCooldown).toBeNull();

    const afterCooldown = await repository.claimPending({
      accountId,
      periodStart,
      maxPacksPerMonth: 5,
      cooldownMs: 0,
    });
    expect(afterCooldown).not.toBeNull();
  });

  it("never lets two concurrent claims for the same account both succeed", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));

    const [first, second] = await Promise.all([
      repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 }),
      repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 }),
    ]);

    const claimed = [first, second].filter((value): value is string => value !== null);
    expect(claimed).toHaveLength(1);
  });

  it("markInvoiceCreated, markFailed, and findById round-trip the row", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const id = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
    expect(id).not.toBeNull();

    await repository.markInvoiceCreated({ id: id!, stripeInvoiceId: `in_${id}` });
    const afterInvoice = await repository.findById(id!);
    expect(afterInvoice?.stripeInvoiceId).toBe(`in_${id}`);
    expect(afterInvoice?.status).toBe("pending");

    await repository.markFailed({ id: id!, failureCode: "card_declined" });
    const afterFailure = await repository.findById(id!);
    expect(afterFailure?.status).toBe("failed");
    expect(afterFailure?.failureCode).toBe("card_declined");
  });

  it("markPaid transitions a failed row to paid -- a retried charge can still succeed", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const id = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
    await repository.markFailed({ id: id!, failureCode: "card_declined" });

    await repository.markPaid(id!);

    expect((await repository.findById(id!))?.status).toBe("paid");
    // Counts toward the monthly cap once resolved to paid, even though it was failed a moment ago.
    expect(await repository.countForPeriod(accountId, periodStart)).toBe(1);
  });

  it("markPaid on an already-paid row is a no-op", async () => {
    const accountId = await seedAccount();
    const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
    const id = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
    await repository.markPaid(id!);

    await expect(repository.markPaid(id!)).resolves.toBeUndefined();
    expect((await repository.findById(id!))?.status).toBe("paid");
  });

  describe("claimStalePending", () => {
    const ageRow = async (id: string, age: string): Promise<void> => {
      await database.query(`UPDATE ee_billing_auto_top_ups SET updated_at = now() - interval '${age}' WHERE id = $1`, [id]);
    };

    it("claims a pending row whose updated_at is older than the lease, and bumps it immediately", async () => {
      const accountId = await seedAccount();
      const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      const id = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
      await repository.markInvoiceCreated({ id: id!, stripeInvoiceId: "in_stale_1" });
      await ageRow(id!, "10 minutes");

      const claimed = await repository.claimStalePending({ leaseMs: 5 * 60_000, limit: 10 });

      expect(claimed).toEqual([{ id, accountId, stripeInvoiceId: "in_stale_1" }]);
      // Immediately re-running must not claim it again -- updated_at was just bumped to now().
      const second = await repository.claimStalePending({ leaseMs: 5 * 60_000, limit: 10 });
      expect(second).toEqual([]);
    });

    it("does not claim a pending row still inside the lease", async () => {
      const accountId = await seedAccount();
      const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });

      const claimed = await repository.claimStalePending({ leaseMs: 5 * 60_000, limit: 10 });

      expect(claimed).toEqual([]);
    });

    it("never lets two concurrent claims take the same stale row", async () => {
      const accountId = await seedAccount();
      const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      const id = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
      await ageRow(id!, "10 minutes");

      const [first, second] = await Promise.all([
        repository.claimStalePending({ leaseMs: 5 * 60_000, limit: 10 }),
        repository.claimStalePending({ leaseMs: 5 * 60_000, limit: 10 }),
      ]);

      const claimed = [...first, ...second];
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(id);
    });

    it("does not claim a paid or failed row", async () => {
      const accountId = await seedAccount();
      const repository = new PostgresAutoTopUpRepository(createEeKysely(pool));
      const id = await repository.claimPending({ accountId, periodStart, maxPacksPerMonth: 5, cooldownMs: 0 });
      await repository.markPaid(id!);
      await ageRow(id!, "10 minutes");

      expect(await repository.claimStalePending({ leaseMs: 5 * 60_000, limit: 10 })).toEqual([]);
    });
  });
});
