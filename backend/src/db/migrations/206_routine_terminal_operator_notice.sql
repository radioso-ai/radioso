-- What a routine ending tells operators. `kind` keeps deciding who owns the conversation after the
-- ending; the notice is a side effect. A hand-off always notifies; a completion notifies only when
-- `operator_notice_enabled` is set. The subject and intro are optional authored text that may
-- reference collected values as {{slot.<key>}}; null renders the default text for the ending's
-- kind, so an enabled notice with neither text is complete.
--
-- Rows written before this column existed read back with no notice of their own: a completion
-- stays silent, and a hand-off keeps notifying with the default text, exactly as before.
--
-- Locks. ADD COLUMN with a constant default and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- routine_terminal for the few milliseconds the catalog change and the CHECK scan take; routine
-- reads and writes wait for that, nothing else does.
ALTER TABLE routine_terminal
  ADD COLUMN IF NOT EXISTS operator_notice_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS operator_notice_subject TEXT,
  ADD COLUMN IF NOT EXISTS operator_notice_intro TEXT;

ALTER TABLE routine_terminal
  DROP CONSTRAINT IF EXISTS routine_terminal_operator_notice_text_check;

ALTER TABLE routine_terminal
  ADD CONSTRAINT routine_terminal_operator_notice_text_check CHECK (
    operator_notice_enabled
    OR (operator_notice_subject IS NULL AND operator_notice_intro IS NULL)
  );
