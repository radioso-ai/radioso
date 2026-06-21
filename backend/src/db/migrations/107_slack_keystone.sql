-- Spec 092 Phase 0: Slack installation keystone.
-- Tokens remain encrypted in integration_oauth_connections; Slack tables hold
-- routing keys and install metadata only.

CREATE TABLE IF NOT EXISTS slack_installations (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL UNIQUE,
  team_name TEXT,
  bot_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_installations_workspace
  ON slack_installations (workspace_id);

CREATE INDEX IF NOT EXISTS idx_slack_installations_connection
  ON slack_installations (connection_id);

CREATE TABLE IF NOT EXISTS slack_channel_bindings (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  answering_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  escalation_channel_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (installation_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_channel_bindings_workspace
  ON slack_channel_bindings (workspace_id);

CREATE INDEX IF NOT EXISTS idx_slack_channel_bindings_answering_agent
  ON slack_channel_bindings (answering_agent_id);

CREATE TABLE IF NOT EXISTS slack_conversation_links (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  slack_key TEXT NOT NULL UNIQUE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_conversation_links_workspace
  ON slack_conversation_links (workspace_id);

CREATE INDEX IF NOT EXISTS idx_slack_conversation_links_installation
  ON slack_conversation_links (installation_id);

CREATE TABLE IF NOT EXISTS slack_inbound_events (
  event_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'skipped', 'failed'))
);
