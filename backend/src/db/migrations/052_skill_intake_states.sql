CREATE TABLE IF NOT EXISTS skill_intake_states (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'active',
    'paused',
    'awaiting_confirmation',
    'awaiting_tool',
    'completed',
    'cancelled',
    'expired',
    'failed'
  )),
  collected JSONB NOT NULL DEFAULT '{}'::jsonb,
  invalid JSONB NOT NULL DEFAULT '{}'::jsonb,
  missing TEXT[] NOT NULL DEFAULT '{}'::text[],
  expires_at TIMESTAMPTZ,
  last_prompted_field TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS skill_intake_states_workspace_conversation_idx
  ON skill_intake_states (workspace_id, conversation_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS skill_intake_states_expiry_idx
  ON skill_intake_states (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS skill_intake_states_one_open_flow_idx
  ON skill_intake_states (workspace_id, conversation_id, skill_name)
  WHERE status IN ('active', 'paused', 'awaiting_confirmation', 'awaiting_tool');
