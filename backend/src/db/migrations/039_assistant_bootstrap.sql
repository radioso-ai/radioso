ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS assistant_name TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS assistant_role TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS greeting_instruction TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS assistant_default_locale TEXT,
ADD COLUMN IF NOT EXISTS proactive_greeting_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bootstrap_greeting_cache (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  locale_used TEXT,
  greeting_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, fingerprint)
);
