ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS chat_provider TEXT
    CHECK (chat_provider IS NULL OR chat_provider IN ('openai', 'openai-compatible', 'gemini', 'claude'));

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS chat_model TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agents_chat_override_pair'
      AND conrelid = 'agents'::regclass
  ) THEN
    ALTER TABLE agents
      ADD CONSTRAINT agents_chat_override_pair CHECK (
        (chat_provider IS NULL AND chat_model IS NULL)
        OR (chat_provider IS NOT NULL AND chat_model IS NOT NULL)
      );
  END IF;
END $$;
