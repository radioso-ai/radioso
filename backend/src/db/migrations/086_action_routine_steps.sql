ALTER TABLE routine_step
  DROP CONSTRAINT IF EXISTS routine_step_kind_check,
  ADD COLUMN IF NOT EXISTS action_type TEXT NULL,
  ADD CHECK (kind IN ('chat', 'tool', 'fork', 'action'));

ALTER TABLE routine_terminal
  DROP CONSTRAINT IF EXISTS routine_terminal_kind_check,
  ADD CHECK (kind IN ('complete', 'handoff'));
