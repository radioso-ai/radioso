-- Feature 089: Sanitized customer email skill activity.
-- Stores metadata and outcomes only; message bodies and credential material are not retained.

CREATE TABLE IF NOT EXISTS email_skill_activity (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  routine_id UUID NULL,
  conversation_id UUID NULL,
  skill_definition_id UUID NOT NULL REFERENCES email_skill_definitions(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES customer_email_connections(id) ON DELETE RESTRICT,
  skill_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('draft', 'send')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'drafted',
    'sent',
    'missing_input',
    'disabled_connection',
    'needs_reauth',
    'provider_rejected',
    'failed'
  )),
  recipient_summary JSONB NOT NULL DEFAULT '{"toCount":0,"ccCount":0,"domains":[],"redactedRecipients":[]}'::jsonb,
  provider_message_id TEXT NULL,
  error_code TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_skill_activity_workspace_created
  ON email_skill_activity (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_skill_activity_agent_created
  ON email_skill_activity (workspace_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_skill_activity_connection_created
  ON email_skill_activity (workspace_id, connection_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_skill_activity_skill_created
  ON email_skill_activity (workspace_id, skill_definition_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_skill_activity_outcome_created
  ON email_skill_activity (workspace_id, outcome, created_at DESC);
