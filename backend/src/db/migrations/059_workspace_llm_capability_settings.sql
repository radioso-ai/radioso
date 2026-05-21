-- Workspace-level chat/rewrite/rerank model preferences live on retrieval_settings
-- alongside the existing rewrite/rerank toggles. Each capability is a nullable
-- (provider, model) pair; both must be set together or both null.

ALTER TABLE retrieval_settings
  ADD COLUMN IF NOT EXISTS chat_provider TEXT
    CHECK (chat_provider IS NULL OR chat_provider IN ('openai', 'openai-compatible', 'gemini', 'claude')),
  ADD COLUMN IF NOT EXISTS chat_model TEXT,
  ADD COLUMN IF NOT EXISTS rewrite_provider TEXT
    CHECK (rewrite_provider IS NULL OR rewrite_provider IN ('openai', 'openai-compatible', 'gemini', 'claude')),
  ADD COLUMN IF NOT EXISTS rewrite_model TEXT,
  ADD COLUMN IF NOT EXISTS rerank_provider TEXT
    CHECK (rerank_provider IS NULL OR rerank_provider IN ('openai', 'openai-compatible', 'gemini', 'claude')),
  ADD COLUMN IF NOT EXISTS rerank_model TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'retrieval_settings_chat_capability_pair' AND conrelid = 'retrieval_settings'::regclass
  ) THEN
    ALTER TABLE retrieval_settings
      ADD CONSTRAINT retrieval_settings_chat_capability_pair CHECK (
        (chat_provider IS NULL AND chat_model IS NULL)
        OR (chat_provider IS NOT NULL AND chat_model IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'retrieval_settings_rewrite_capability_pair' AND conrelid = 'retrieval_settings'::regclass
  ) THEN
    ALTER TABLE retrieval_settings
      ADD CONSTRAINT retrieval_settings_rewrite_capability_pair CHECK (
        (rewrite_provider IS NULL AND rewrite_model IS NULL)
        OR (rewrite_provider IS NOT NULL AND rewrite_model IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'retrieval_settings_rerank_capability_pair' AND conrelid = 'retrieval_settings'::regclass
  ) THEN
    ALTER TABLE retrieval_settings
      ADD CONSTRAINT retrieval_settings_rerank_capability_pair CHECK (
        (rerank_provider IS NULL AND rerank_model IS NULL)
        OR (rerank_provider IS NOT NULL AND rerank_model IS NOT NULL)
      );
  END IF;
END $$;
