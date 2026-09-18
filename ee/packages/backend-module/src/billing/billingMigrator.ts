import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

// Idempotent DDL, following the `usageLimitMigrator.ts` pattern: every statement is
// `IF NOT EXISTS` / `DROP ... IF EXISTS` + re-`ADD CONSTRAINT` so re-running this migrator on an
// already-migrated database is a no-op.
export const billingMigrator: ApplicationDatabaseMigrator = {
  id: "ee-billing",
  async migrate(database) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_billing_customers (
        account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        stripe_customer_id TEXT UNIQUE NOT NULL,
        stripe_subscription_id TEXT,
        price_id TEXT,
        interval TEXT,
        status TEXT NOT NULL DEFAULT 'none',
        billing_email TEXT,
        current_period_end TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      ALTER TABLE ee_billing_customers
      DROP CONSTRAINT IF EXISTS ee_billing_customers_status_check
    `);
    await database.query(`
      ALTER TABLE ee_billing_customers
      ADD CONSTRAINT ee_billing_customers_status_check
      CHECK (status IN ('active', 'past_due', 'canceled', 'none'))
    `);

    await database.query(`
      ALTER TABLE ee_billing_customers
      DROP CONSTRAINT IF EXISTS ee_billing_customers_interval_check
    `);
    await database.query(`
      ALTER TABLE ee_billing_customers
      ADD CONSTRAINT ee_billing_customers_interval_check
      CHECK (interval IS NULL OR interval IN ('month', 'year'))
    `);

    // Webhook idempotency. `event_id` is Stripe's own event id: `INSERT ... ON CONFLICT (event_id)
    // DO NOTHING` inside the handler's transaction is the whole dedupe story (see
    // `billingWebhookHandler.ts`). `account_id` is nullable because some outcomes (unknown
    // customer, unmapped price) never resolve one.
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_billing_processed_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
        outcome TEXT NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_billing_processed_events_account
        ON ee_billing_processed_events (account_id)
    `);
  },
};
