-- Spec 092 Phase R: provider-neutral OAuth-backed integration connection spine.
-- Tokens and other credential material remain only on integration_oauth_connections.

CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  oauth_connection_id UUID NOT NULL REFERENCES integration_oauth_connections(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized', 'disabled', 'needs_reauth', 'error')),
  last_health_status TEXT
    CHECK (last_health_status IS NULL OR last_health_status IN ('ok', 'failed', 'unknown')),
  last_health_checked_at TIMESTAMPTZ,
  last_error_code TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_connections_workspace
  ON integration_connections (workspace_id);

CREATE INDEX IF NOT EXISTS idx_integration_connections_workspace_provider
  ON integration_connections (workspace_id, provider);

CREATE INDEX IF NOT EXISTS idx_integration_connections_oauth
  ON integration_connections (oauth_connection_id);
