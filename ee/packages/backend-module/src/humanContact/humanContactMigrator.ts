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
        default_emails TEXT[],
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
        ADD COLUMN IF NOT EXISTS default_emails TEXT[],
        ADD COLUMN IF NOT EXISTS webhook_enabled BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await database.query(`
      UPDATE ee_contact_settings
      SET default_emails = ARRAY[default_email]
      WHERE default_emails IS NULL
        AND default_email IS NOT NULL
    `);

    await database.query(`
      UPDATE ee_contact_settings
      SET webhook_enabled = TRUE
      WHERE webhook_enabled = FALSE
        AND webhook_url IS NOT NULL
        AND signing_secret IS NOT NULL
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
          -- HUMAN_CONTACT_SKILL_NAME is 'human_contact.request'; SQL migrations cannot import TS constants.
          SELECT
            id, account_id, workspace_id, conversation_id, assistant_message_id,
            'human_contact.request', source_channel, source_origin, trigger_source, trigger_reason,
            idempotency_key,
            jsonb_build_object('email', btrim(user_email), 'message', message),
            lower(btrim(user_email)), status, attempts,
            next_retry_at, final_delivery_error, activity_trace, created_at, updated_at
          FROM ee_contact_requests
          WHERE NOT EXISTS (
            SELECT 1
            FROM skill_submissions existing
            WHERE existing.id = ee_contact_requests.id
          )
            AND (
              ee_contact_requests.idempotency_key IS NULL
              OR NOT EXISTS (
                SELECT 1
                FROM skill_submissions existing
                WHERE existing.workspace_id = ee_contact_requests.workspace_id
                  AND existing.skill_name = 'human_contact.request'
                  AND existing.idempotency_key = ee_contact_requests.idempotency_key
              )
            );

          DROP TABLE ee_contact_requests;
        END IF;
      END $$;
    `);
  },
};
