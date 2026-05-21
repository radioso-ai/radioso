CREATE TABLE IF NOT EXISTS workspace_provider_credentials (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'openai-compatible', 'gemini', 'claude')),
  ciphertext TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider)
);
