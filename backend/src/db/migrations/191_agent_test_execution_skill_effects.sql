-- Freezes the skill-effect policy chosen at test-execution start (spec: Test Chat skill
-- effects toggle), so every turn/retry of that execution replays the same choice.
ALTER TABLE agent_test_executions
  ADD COLUMN skill_effects TEXT NOT NULL DEFAULT 'suppressed' CHECK (skill_effects IN ('suppressed', 'allowed'));
