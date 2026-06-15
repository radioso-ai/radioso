-- Feature 089: Provider-neutral OAuth connections for workspace integrations.
-- Secrets are encrypted before persistence using fieldEncryption. The table is
-- scoped to workspaces so email and future integrations do not depend on MCP.

CREATE TABLE IF NOT EXISTS integration_oauth_connections (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_id TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'authorized', 'needs_reauth', 'disabled', 'error')),
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  credential_ciphertext TEXT,
  encryption_key_id TEXT,
  oauth_client_ciphertext TEXT,
  oauth_flow_ciphertext TEXT,
  last_refresh_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_connections_workspace
  ON integration_oauth_connections (workspace_id);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_connections_workspace_provider
  ON integration_oauth_connections (workspace_id, provider);
