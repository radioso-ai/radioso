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
-- Filter index. The Inbox filter reads the conversation values of enum variables by key. An enum
-- key is a short string, while other values may be up to 32 KB, past the size a btree entry can
-- hold, so the index takes only short string values and never refuses a write.
--
-- Locks. The runner applies a migration file in one transaction, so every lock taken here is held
-- until it commits, and an index cannot be built CONCURRENTLY. Each ALTER takes ACCESS EXCLUSIVE on
-- its table: until the commit, every read and write of `context_variables` and
-- `context_variable_values` waits, a chat turn's read of its attributes included. The new columns'
-- defaults are catalog changes. The CHECKs are added NOT VALID, which binds new rows at once, and
-- then validated, which scans each table under the lock already held; the index build is the other
-- scan. Both tables are small. The wait for each lock is bounded to three seconds; a deploy that
-- hits it rolls back and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE context_variables
  DROP CONSTRAINT context_variables_value_type_check,
  ADD CONSTRAINT context_variables_value_type_check CHECK (value_type IN ('string', 'json', 'enum')) NOT VALID,
  ADD COLUMN options JSONB NULL,
  ADD CONSTRAINT context_variables_options_check CHECK (
    (value_type = 'enum') = (options IS NOT NULL AND jsonb_typeof(options) = 'array')
  ) NOT VALID;

ALTER TABLE context_variables VALIDATE CONSTRAINT context_variables_value_type_check;
ALTER TABLE context_variables VALIDATE CONSTRAINT context_variables_options_check;

ALTER TABLE context_variable_values
  DROP CONSTRAINT context_variable_values_scope_type_check,
  ADD CONSTRAINT context_variable_values_scope_type_check
    CHECK (scope_type IN ('conversation', 'session', 'customer', 'agent', 'workspace')) NOT VALID,
  ADD COLUMN written_by_kind TEXT NOT NULL DEFAULT 'api',
  ADD CONSTRAINT context_variable_values_written_by_kind_check
    CHECK (written_by_kind IN ('api', 'operator', 'routine', 'classifier')) NOT VALID,
  ADD COLUMN written_by_ref TEXT NULL;

ALTER TABLE context_variable_values VALIDATE CONSTRAINT context_variable_values_scope_type_check;
ALTER TABLE context_variable_values VALIDATE CONSTRAINT context_variable_values_written_by_kind_check;

CREATE INDEX idx_context_variable_values_variable_scope_data
  ON context_variable_values (variable_id, scope_type, data)
  WHERE jsonb_typeof(data) = 'string' AND octet_length(data #>> '{}') <= 120;
