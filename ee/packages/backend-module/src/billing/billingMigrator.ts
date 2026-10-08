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

    // Opt-in auto top-up. One settings row per account (upserted, never inserted bare), and a
    // ledger row per attempted pack purchase -- `status` tracks it from the sweep's `pending`
    // through the webhook's `paid`/`failed`, the same two-table split as the usage-alert claims.
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_billing_auto_top_up_settings (
        account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT false,
        max_packs_per_month INTEGER NOT NULL,
        disabled_reason TEXT,
        disabled_at TIMESTAMPTZ,
        updated_by_user_id UUID,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      ALTER TABLE ee_billing_auto_top_up_settings
      DROP CONSTRAINT IF EXISTS ee_billing_auto_top_up_settings_max_packs_check
    `);
    await database.query(`
      ALTER TABLE ee_billing_auto_top_up_settings
      ADD CONSTRAINT ee_billing_auto_top_up_settings_max_packs_check
      CHECK (max_packs_per_month >= 1)
    `);

    await database.query(`
      ALTER TABLE ee_billing_auto_top_up_settings
      DROP CONSTRAINT IF EXISTS ee_billing_auto_top_up_settings_disabled_reason_check
    `);
    await database.query(`
      ALTER TABLE ee_billing_auto_top_up_settings
      ADD CONSTRAINT ee_billing_auto_top_up_settings_disabled_reason_check
      CHECK (disabled_reason IS NULL OR disabled_reason IN ('payment_failed'))
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_billing_auto_top_ups (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        status TEXT NOT NULL,
        stripe_invoice_id TEXT,
        failure_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      ALTER TABLE ee_billing_auto_top_ups
      DROP CONSTRAINT IF EXISTS ee_billing_auto_top_ups_status_check
    `);
    await database.query(`
      ALTER TABLE ee_billing_auto_top_ups
      ADD CONSTRAINT ee_billing_auto_top_ups_status_check
      CHECK (status IN ('pending', 'paid', 'failed'))
    `);

    await database.query(`
      ALTER TABLE ee_billing_auto_top_ups
      DROP CONSTRAINT IF EXISTS ee_billing_auto_top_ups_stripe_invoice_id_key
    `);
    await database.query(`
      ALTER TABLE ee_billing_auto_top_ups
      ADD CONSTRAINT ee_billing_auto_top_ups_stripe_invoice_id_key
      UNIQUE (stripe_invoice_id)
    `);

    // The pending guard: at most one in-flight pack per account. Enforced by the database (not
    // just the sweep's own read-before-write) so two API instances racing the same tick can
    // insert at most one row between them -- the loser's insert simply fails this index.
    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_billing_auto_top_ups_one_pending_per_account
        ON ee_billing_auto_top_ups (account_id)
        WHERE status = 'pending'
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_billing_auto_top_ups_account_period
        ON ee_billing_auto_top_ups (account_id, period_start)
    `);
  },
};
