CREATE TABLE copilot_proposals (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES copilot_conversations(id) ON DELETE CASCADE,
  message_id UUID NULL REFERENCES copilot_messages(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('directive', 'agent_setting')),
  target_ref JSONB NOT NULL,
  payload JSONB NOT NULL,
  version_token TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'dismissed', 'failed', 'stale')) DEFAULT 'pending',
  failure_reason TEXT NULL,
  apply_started_at TIMESTAMPTZ NULL,
  applied_ref JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX copilot_proposals_operator_created_idx
  ON copilot_proposals (workspace_id, operator_user_id, created_at DESC);

CREATE INDEX copilot_proposals_conversation_message_idx
  ON copilot_proposals (conversation_id, message_id, created_at ASC);
