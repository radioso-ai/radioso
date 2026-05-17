import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

export const skillSubmissionMigrator: ApplicationDatabaseMigrator = {
  id: "ee-skill-submissions",
  async migrate(database) {
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
        fields JSONB NOT NULL,
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
      ALTER TABLE skill_submissions
        ALTER COLUMN fields DROP DEFAULT
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
      DO $$
      DECLARE
        current_index_definition TEXT;
      BEGIN
        IF to_regclass('public.skill_submissions_due_idx') IS NOT NULL THEN
          SELECT pg_get_indexdef('public.skill_submissions_due_idx'::regclass)
            INTO current_index_definition;

          IF current_index_definition NOT LIKE '%WHERE (status = ''pending''::text)%'
             AND current_index_definition NOT LIKE '%WHERE status = ''pending''%' THEN
            DROP INDEX skill_submissions_due_idx;
          END IF;
        END IF;
      END $$;
    `);

    await database.query(`
      DO $$
      DECLARE
        current_index_definition TEXT;
      BEGIN
        IF to_regclass('public.skill_submissions_subject_identity_idx') IS NOT NULL THEN
          SELECT pg_get_indexdef('public.skill_submissions_subject_identity_idx'::regclass)
            INTO current_index_definition;

          IF current_index_definition NOT LIKE '%(workspace_id, subject_identity)%' THEN
            DROP INDEX skill_submissions_subject_identity_idx;
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
        ON skill_submissions (next_retry_at, created_at)
        WHERE status = 'pending'
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS skill_submissions_workspace_listing_idx
        ON skill_submissions (workspace_id, skill_name, created_at DESC, id DESC)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS skill_submissions_subject_identity_idx
        ON skill_submissions (workspace_id, subject_identity)
        WHERE subject_identity IS NOT NULL
    `);
  },
};
