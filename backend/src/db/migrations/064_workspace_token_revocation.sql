ALTER TABLE workspace_tokens
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_workspace_tokens_active_token_hash
  ON workspace_tokens (token_hash)
  WHERE revoked_at IS NULL;
