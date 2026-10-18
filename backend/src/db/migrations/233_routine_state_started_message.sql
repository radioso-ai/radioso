-- The visitor message that activated the current routine execution. The execution id beside it
-- makes the anchor self-invalidating during a rolling deploy: an older revision can replace a
-- routine_states row without knowing these columns, but its new execution id no longer matches
-- the stored anchor's execution id, so readers will not reuse the previous run's boundary.
ALTER TABLE routine_states
  ADD COLUMN IF NOT EXISTS started_message_id UUID,
  ADD COLUMN IF NOT EXISTS started_execution_id UUID;

-- Metadata-only opt-in for an outbox-time AI summary. A constant false default keeps existing
-- endings quiet and is a catalog-only change on supported PostgreSQL versions.
ALTER TABLE routine_terminal
  ADD COLUMN IF NOT EXISTS operator_notice_include_ai_summary BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE routine_terminal
  DROP CONSTRAINT IF EXISTS routine_terminal_operator_notice_ai_summary_check;

ALTER TABLE routine_terminal
  ADD CONSTRAINT routine_terminal_operator_notice_ai_summary_check CHECK (
    operator_notice_enabled OR NOT operator_notice_include_ai_summary
  );
