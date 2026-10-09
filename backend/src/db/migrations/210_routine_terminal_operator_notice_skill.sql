-- The notify skill that delivers a routine ending's operator notice, by name, the way a step names
-- the skill it runs. Null means the default destination: `contact_human`, then the agent's contact
-- settings, then the workspace owner or admin. Rows written before this column existed read back
-- with no skill named, so every existing notice keeps its destination.
--
-- No foreign key: the routine names WHICH skill, and the skill owns WHERE it sends. A skill that
-- is renamed, removed, or turned off is reported by routine validation, and delivery falls back to
-- the default destination rather than dropping the notice.
--
-- Locks. ADD COLUMN without a default and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- routine_terminal for the few milliseconds the catalog change and the CHECK scan take; routine
-- reads and writes wait for that, nothing else does.
ALTER TABLE routine_terminal
  ADD COLUMN IF NOT EXISTS operator_notice_skill_name TEXT;

ALTER TABLE routine_terminal
  DROP CONSTRAINT IF EXISTS routine_terminal_operator_notice_skill_check;

ALTER TABLE routine_terminal
  ADD CONSTRAINT routine_terminal_operator_notice_skill_check CHECK (
    (operator_notice_enabled OR operator_notice_skill_name IS NULL)
    AND (operator_notice_skill_name IS NULL OR btrim(operator_notice_skill_name) <> '')
  );
