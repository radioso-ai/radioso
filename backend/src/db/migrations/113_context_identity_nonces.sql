CREATE TABLE context_identity_nonces (
  nonce TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_context_identity_nonces_workspace_expires
  ON context_identity_nonces (workspace_id, expires_at);
