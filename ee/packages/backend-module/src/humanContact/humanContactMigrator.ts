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
      CREATE TABLE IF NOT EXISTS skill_submissions (
        id UUID PRIMARY KEY,
        account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        assistant_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
        skill_name TEXT NOT NULL,
        source_channel TEXT,
        source_origin TEXT,
        trigger_source TEXT NOT NULL,
        trigger_reason TEXT,
        idempotency_key TEXT,
        fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        subject_identity TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        final_delivery_error TEXT,
        activity_trace JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT skill_submissions_status_check
          CHECK (status IN ('pending', 'delivering', 'delivered', 'failed'))
      )
    `);

    await database.query(`
      DO $$
      DECLARE
        current_index_definition TEXT;
      BEGIN
        IF to_regclass('public.skill_submissions_idempotency_key_idx') IS NOT NULL THEN
          SELECT pg_get_indexdef('public.skill_submissions_idempotency_key_idx'::regclass)
            INTO current_index_definition;

          IF current_index_definition NOT LIKE '%(workspace_id, skill_name, idempotency_key)%' THEN
            DROP INDEX skill_submissions_idempotency_key_idx;
          END IF;
        END IF;
      END $$;
    `);

    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS skill_submissions_idempotency_key_idx
        ON skill_submissions (workspace_id, skill_name, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS skill_submissions_due_idx
        ON skill_submissions (status, next_retry_at, created_at)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS skill_submissions_workspace_listing_idx
        ON skill_submissions (workspace_id, skill_name, created_at DESC, id DESC)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS skill_submissions_subject_identity_idx
        ON skill_submissions (subject_identity)
        WHERE subject_identity IS NOT NULL
    `);

    await database.query(`
      DO $$
      BEGIN
        IF to_regclass('public.ee_contact_requests') IS NOT NULL THEN
          ALTER TABLE ee_contact_requests
            ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
            ADD COLUMN IF NOT EXISTS activity_trace JSONB;

          INSERT INTO skill_submissions (
            id, account_id, workspace_id, conversation_id, assistant_message_id,
            skill_name, source_channel, source_origin, trigger_source, trigger_reason,
            idempotency_key, fields, subject_identity, status, attempts,
            next_retry_at, final_delivery_error, activity_trace, created_at, updated_at
          )
          SELECT
            id, account_id, workspace_id, conversation_id, assistant_message_id,
            'human_contact.request', source_channel, source_origin, trigger_source, trigger_reason,
            idempotency_key,
            jsonb_build_object('email', btrim(user_email), 'message', message),
            lower(btrim(user_email)), status, attempts,
            next_retry_at, final_delivery_error, activity_trace, created_at, updated_at
          FROM ee_contact_requests
          ON CONFLICT (id) DO NOTHING;

          DROP TABLE ee_contact_requests;
        END IF;
      END $$;
    `);
  },
};
