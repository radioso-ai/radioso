CREATE TABLE copilot_conversations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('idle', 'running')) DEFAULT 'idle',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX copilot_conversations_operator_updated_idx
  ON copilot_conversations (workspace_id, operator_user_id, updated_at DESC);

CREATE TABLE copilot_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES copilot_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('operator', 'copilot')),
  content TEXT NOT NULL,
  outcome TEXT NULL CHECK (outcome IN ('completed', 'budget_exhausted', 'failed')),
  activity JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX copilot_messages_conversation_created_idx
  ON copilot_messages (conversation_id, created_at ASC);
