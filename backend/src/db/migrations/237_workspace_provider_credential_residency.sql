-- An OpenAI workspace credential (bring-your-own-key) records which OpenAI data-residency
-- endpoint it calls, authored by the operator when they save the key — never inferred from the
-- key itself. Every other provider's row carries the column too (it is one table), but only an
-- "openai" row's value is ever read; the default keeps every pre-existing row's behavior
-- unchanged (OpenAI's global endpoint, matching #1555's platform-key default).
ALTER TABLE workspace_provider_credentials
  ADD COLUMN IF NOT EXISTS residency TEXT NOT NULL DEFAULT 'global'
  CHECK (residency IN ('global', 'us', 'eu'));
