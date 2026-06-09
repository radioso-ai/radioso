import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

// NOTE: the durable usage-event ledger (usage_events / embedding_usage_items /
// usage_daily_rollups) is now owned by OSS (backend migration
// 067_usage_ledger_oss.sql) and written by the OSS DurableUsageEventRecorder.
// This EE migrator owns only the usage-LIMIT tables (profiles, assignments,
// counters, reservations). It must not create the event tables — OSS migrations
// run first at boot and rename the legacy ee_usage_* tables in place.
export const usageLimitMigrator: ApplicationDatabaseMigrator = {
  id: "ee-usage-limits",
  async migrate(database) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_limit_profiles (
        key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        monthly_answer_limit INTEGER,
        stored_document_limit INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ee_usage_limit_profiles_monthly_answer_limit_check
          CHECK (monthly_answer_limit IS NULL OR monthly_answer_limit >= 0),
        CONSTRAINT ee_usage_limit_profiles_stored_document_limit_check
          CHECK (stored_document_limit IS NULL OR stored_document_limit >= 0)
      )
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_limit_account_assignments (
        account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        profile_key TEXT NOT NULL REFERENCES ee_usage_limit_profiles(key) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_limit_answer_counters (
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, period_start)
      )
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_limit_document_reservations (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_usage_limit_document_reservations_account_active
        ON ee_usage_limit_document_reservations (account_id, expires_at)
    `);

    await database.query(`
      ALTER TABLE ee_usage_limit_profiles
      ADD COLUMN IF NOT EXISTS stored_indexed_byte_limit BIGINT
    `);

    await database.query(`
      ALTER TABLE ee_usage_limit_profiles
      ADD COLUMN IF NOT EXISTS monthly_indexed_byte_limit BIGINT
    `);

    await database.query(`
      ALTER TABLE ee_usage_limit_profiles
      DROP CONSTRAINT IF EXISTS ee_usage_limit_profiles_stored_indexed_byte_limit_check
    `);

    await database.query(`
      ALTER TABLE ee_usage_limit_profiles
      ADD CONSTRAINT ee_usage_limit_profiles_stored_indexed_byte_limit_check
      CHECK (stored_indexed_byte_limit IS NULL OR stored_indexed_byte_limit >= 0)
    `);

    await database.query(`
      ALTER TABLE ee_usage_limit_profiles
      DROP CONSTRAINT IF EXISTS ee_usage_limit_profiles_monthly_indexed_byte_limit_check
    `);

    await database.query(`
      ALTER TABLE ee_usage_limit_profiles
      ADD CONSTRAINT ee_usage_limit_profiles_monthly_indexed_byte_limit_check
      CHECK (monthly_indexed_byte_limit IS NULL OR monthly_indexed_byte_limit >= 0)
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_limit_storage_reservations (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        bytes_reserved BIGINT NOT NULL CHECK (bytes_reserved >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_usage_limit_storage_reservations_account_active
        ON ee_usage_limit_storage_reservations (account_id, expires_at)
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_limit_monthly_indexed_byte_counters (
        account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (account_id, period_start)
      )
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_org_creation_counters (
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        period_start DATE NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, period_start)
      )
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_org_creation_overrides (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        monthly_limit INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ee_org_creation_overrides_monthly_limit_check
          CHECK (monthly_limit IS NULL OR monthly_limit >= 0)
      )
    `);

    await database.query(`
      INSERT INTO ee_usage_limit_profiles (
        key,
        display_name,
        monthly_answer_limit,
        stored_document_limit
      )
      VALUES
        ('starter_100', 'Starter 100', 100, 100),
        ('starter_250', 'Starter 250', 250, 250)
      ON CONFLICT (key) DO NOTHING
    `);
  },
};
