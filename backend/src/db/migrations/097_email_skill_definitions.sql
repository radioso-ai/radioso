-- Feature 089: Agent email skill definitions.
-- This is definition/CRUD only. Runtime draft/send dispatch is a later slice.

CREATE TABLE IF NOT EXISTS email_skill_definitions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES customer_email_connections(id) ON DELETE RESTRICT,
  skill_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'draft' CHECK (mode IN ('draft', 'send')),
  bound_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  exposed_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_email_skill_definitions_workspace
  ON email_skill_definitions (workspace_id);

CREATE INDEX IF NOT EXISTS idx_email_skill_definitions_agent
  ON email_skill_definitions (workspace_id, agent_id);

CREATE INDEX IF NOT EXISTS idx_email_skill_definitions_connection
  ON email_skill_definitions (workspace_id, connection_id);
