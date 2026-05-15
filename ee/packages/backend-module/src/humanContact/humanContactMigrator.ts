import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

export const humanContactMigrator: ApplicationDatabaseMigrator = {
  id: "ee-human-contact",
  async migrate(database) {
    await database.query(`
      DO $$
      BEGIN
        IF to_regclass('public.ee_human_contact_settings') IS NOT NULL
           AND to_regclass('public.ee_contact_settings') IS NULL THEN
          ALTER TABLE ee_human_contact_settings RENAME TO ee_contact_settings;
        END IF;

        IF to_regclass('public.ee_human_contact_requests') IS NOT NULL
           AND to_regclass('public.ee_contact_requests') IS NULL THEN
          ALTER TABLE ee_human_contact_requests RENAME TO ee_contact_requests;
        END IF;
      END $$;
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_contact_settings (
        workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        webhook_url TEXT,
        signing_secret TEXT,
        email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        default_email TEXT,
        webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ee_contact_settings_webhook_url_check
          CHECK (webhook_url IS NULL OR char_length(webhook_url) <= 2048),
        CONSTRAINT ee_contact_settings_signing_secret_check
          CHECK (signing_secret IS NULL OR char_length(signing_secret) >= 16),
        CONSTRAINT ee_contact_settings_default_email_check
          CHECK (default_email IS NULL OR char_length(default_email) <= 320)
      )
    `);

    await database.query(`
      ALTER TABLE ee_contact_settings
        ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS default_email TEXT,
        ADD COLUMN IF NOT EXISTS webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await database.query(`
      UPDATE ee_contact_settings
      SET webhook_enabled = TRUE
      WHERE webhook_enabled = FALSE
        AND webhook_url IS NOT NULL
        AND signing_secret IS NOT NULL
    `);

    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_contact_requests (
        id UUID PRIMARY KEY,
        account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        assistant_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        source_channel TEXT,
        source_origin TEXT,
        user_email TEXT NOT NULL,
        message TEXT NOT NULL,
        generated_summary TEXT NOT NULL,
        trigger_source TEXT NOT NULL,
        trigger_reason TEXT,
        idempotency_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        final_delivery_error TEXT,
        activity_trace JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ee_contact_requests_status_check
          CHECK (status IN ('pending', 'delivering', 'delivered', 'failed'))
      )
    `);

    await database.query(`
      ALTER TABLE ee_contact_requests
        ADD COLUMN IF NOT EXISTS activity_trace JSONB,
        ADD COLUMN IF NOT EXISTS idempotency_key TEXT
    `);

    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ee_contact_requests_idempotency_key_idx
        ON ee_contact_requests (workspace_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_contact_requests_due
        ON ee_contact_requests (status, next_retry_at, created_at)
    `);
  },
};
