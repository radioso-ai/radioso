ALTER TABLE eval_cases
  ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'safe_test',
  ADD CONSTRAINT eval_cases_execution_mode_check
    CHECK (execution_mode IN ('live', 'safe_test'));
