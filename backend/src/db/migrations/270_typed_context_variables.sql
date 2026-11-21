-- Typed attributes (#1884): context variables gain an `enum` value type with described options, a
-- `conversation` scope every channel has, and a record of who last wrote each value.
--
-- Options. An enum variable carries its choices as a JSON array of `{key, label, description,
-- archived}`. A stored value holds the key. Keys never change and options are archived, never
-- removed, so a stored key always names an option; the application enforces both. Only an enum
-- variable has options.
--
-- Scope. `conversation` values are keyed by `conversations.id` in the generic `scope_id`. The
-- context-variables eraser deletes them with their conversation.
--
-- Provenance. `written_by_kind` names the last writer (`api`, `operator`, `routine`, `classifier`)
-- and `written_by_ref` what wrote it (an API credential or user id, a routine execution, a
-- classifier prompt version). Rows written before this migration read as `api` with no reference.
--
-- Locks. The runner applies a migration file in one transaction, so a lock taken here is held until
-- it commits. Each ALTER takes ACCESS EXCLUSIVE on its table, which every read and write waits for,
-- a chat turn's read of its attributes included, so this file makes catalog changes only and holds
-- the lock for milliseconds: the CHECKs are swapped in NOT VALID, which binds new rows at once
-- without scanning the old ones, and the new columns are nullable or take a constant default, which
-- rewrites nothing. 271 validates the CHECKs and builds the indexes after this commits, under locks
-- no read waits for. The wait for each lock is bounded to three seconds, because reads queue behind
-- a waiting ACCESS EXCLUSIVE; a deploy that hits the bound rolls back and a retry is safe.
--
-- Rollback is app-only: the previous release runs on this schema as it stands, and this migration
-- is not reverted. While it runs, its eraser deletes only `session` values, so a conversation
-- erased in that window leaves its `conversation` values behind with nothing left to erase or
-- export them, and it accepts any string as an `enum` value. After rolling forward again, delete
-- the orphaned values:
--
--   DELETE FROM context_variable_values v
--    WHERE scope_type = 'conversation'
--      AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id::text = v.scope_id);
SET LOCAL lock_timeout = '3s';

ALTER TABLE context_variables
  DROP CONSTRAINT context_variables_value_type_check,
  ADD CONSTRAINT context_variables_value_type_check CHECK (value_type IN ('string', 'json', 'enum')) NOT VALID,
  ADD COLUMN options JSONB NULL,
  ADD CONSTRAINT context_variables_options_check CHECK (
    (value_type = 'enum') = (options IS NOT NULL AND jsonb_typeof(options) = 'array')
  ) NOT VALID;

ALTER TABLE context_variable_values
  DROP CONSTRAINT context_variable_values_scope_type_check,
  ADD CONSTRAINT context_variable_values_scope_type_check
    CHECK (scope_type IN ('conversation', 'session', 'customer', 'agent', 'workspace')) NOT VALID,
  ADD COLUMN written_by_kind TEXT NOT NULL DEFAULT 'api',
  ADD CONSTRAINT context_variable_values_written_by_kind_check
    CHECK (written_by_kind IN ('api', 'operator', 'routine', 'classifier')) NOT VALID,
  ADD COLUMN written_by_ref TEXT NULL;
