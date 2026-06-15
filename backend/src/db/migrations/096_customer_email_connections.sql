-- Feature 089: Customer-owned workspace email connections.
-- Customer outbound email is intentionally separate from modules/mail, which
-- continues to own Radioso transactional email.

CREATE TABLE IF NOT EXISTS customer_email_connections (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  oauth_connection_id UUID NOT NULL REFERENCES integration_oauth_connections(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  sender_name TEXT,
  reply_to_email TEXT,
  status TEXT NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized', 'disabled', 'needs_reauth', 'error')),
  last_health_status TEXT
    CHECK (last_health_status IS NULL OR last_health_status IN ('ok', 'failed', 'unknown')),
  last_health_checked_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_email_connections_workspace
  ON customer_email_connections (workspace_id);

CREATE INDEX IF NOT EXISTS idx_customer_email_connections_oauth
  ON customer_email_connections (oauth_connection_id);
