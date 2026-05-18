import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

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
      CREATE TABLE IF NOT EXISTS ee_usage_events (
        id UUID PRIMARY KEY,
        idempotency_key TEXT UNIQUE NOT NULL,
        account_id UUID,
        workspace_id UUID,
        source_id UUID,
        document_id UUID,
        document_revision INTEGER,
        conversation_id UUID,
        message_id UUID,
        job_id UUID,
        surface TEXT NOT NULL,
        operation TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        input_bytes BIGINT NOT NULL DEFAULT 0,
        output_bytes BIGINT NOT NULL DEFAULT 0,
        vector_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        usage_quality TEXT NOT NULL,
        provider_request_id TEXT,
        error_code TEXT,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_usage_events_account_occurred_at
        ON ee_usage_events (account_id, occurred_at)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_usage_events_account_operation_day
        ON ee_usage_events (account_id, operation, occurred_at)
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_embedding_usage_items (
        usage_event_id UUID NOT NULL REFERENCES ee_usage_events(id) ON DELETE CASCADE,
        document_id UUID NOT NULL,
        document_revision INTEGER NOT NULL,
        chunk_id UUID,
        chunk_index INTEGER NOT NULL,
        content_bytes BIGINT NOT NULL,
        estimated_tokens BIGINT,
        PRIMARY KEY (usage_event_id, document_id, document_revision, chunk_index)
      )
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_usage_daily_rollups (
        account_id UUID NOT NULL,
        usage_date DATE NOT NULL,
        operation TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        total_tokens BIGINT NOT NULL DEFAULT 0,
        input_bytes BIGINT NOT NULL DEFAULT 0,
        output_bytes BIGINT NOT NULL DEFAULT 0,
        vector_count BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, usage_date, operation, provider, model)
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
