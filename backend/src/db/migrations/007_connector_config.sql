-- Connector plugin infrastructure tables

CREATE TABLE IF NOT EXISTS connector_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config_data JSONB NOT NULL DEFAULT '{}',
  error_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_connector_configs_workspace_id ON connector_configs (workspace_id);
CREATE INDEX IF NOT EXISTS idx_connector_configs_connector_id ON connector_configs (connector_id);

-- Tracks which connector-specific migrations have been applied.
CREATE TABLE IF NOT EXISTS connector_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id TEXT NOT NULL,
  migration_name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (connector_id, migration_name)
);

-- Add source_channel to conversations so connector-originated chats are identifiable (FR-010).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_channel TEXT;
