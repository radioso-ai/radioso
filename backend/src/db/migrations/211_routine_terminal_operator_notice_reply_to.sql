-- The field whose collected address replies to a routine ending's operator notice go to, by slot
-- key, the way the notice text names a field as {{slot.<key>}}. Null means no reply-to. Rows
-- written before this column existed read back with no reply-to, so every existing notice keeps
-- sending exactly as it did.
--
-- No foreign key: slots live in routine_slot, keyed by stable id, and the key is the routine's
-- own vocabulary. Routine validation reports a reply-to that names no email field the routine
-- declares, and delivery sets no reply-to when the field was not collected.
--
-- Locks. ADD COLUMN without a default and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- routine_terminal for the few milliseconds the catalog change and the CHECK scan take; routine
-- reads and writes wait for that, nothing else does.
ALTER TABLE routine_terminal
  ADD COLUMN IF NOT EXISTS operator_notice_reply_to_slot TEXT;

ALTER TABLE routine_terminal
  DROP CONSTRAINT IF EXISTS routine_terminal_operator_notice_reply_to_check;

ALTER TABLE routine_terminal
  ADD CONSTRAINT routine_terminal_operator_notice_reply_to_check CHECK (
    (operator_notice_enabled OR operator_notice_reply_to_slot IS NULL)
    AND (operator_notice_reply_to_slot IS NULL OR btrim(operator_notice_reply_to_slot) <> '')
  );
