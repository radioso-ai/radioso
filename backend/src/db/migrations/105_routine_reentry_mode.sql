-- Routine reentry policy (issue #746). Controls whether a completed routine instance
-- suppresses future activation within the same conversation. The default preserves the
-- historical behaviour (a completed instance suppresses re-activation), so every existing
-- routine keeps running once per conversation.
ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS activation_reentry_mode TEXT NOT NULL DEFAULT 'once_per_conversation';

ALTER TABLE routine_definition
  DROP CONSTRAINT IF EXISTS routine_definition_activation_reentry_mode_check;

ALTER TABLE routine_definition
  ADD CONSTRAINT routine_definition_activation_reentry_mode_check
  CHECK (activation_reentry_mode IN ('once_per_conversation', 'always', 'semantic'));
