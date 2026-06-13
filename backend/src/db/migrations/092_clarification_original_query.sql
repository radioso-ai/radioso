ALTER TABLE clarification_states
  ADD COLUMN IF NOT EXISTS original_query TEXT NULL,
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'ask';

UPDATE clarification_states
   SET mode = 'ask'
 WHERE mode IS NULL;
