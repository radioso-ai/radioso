ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS anonymous_chat_enabled BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS anonymous_chat_token TEXT,
ADD COLUMN IF NOT EXISTS anonymous_rate_limit INTEGER NOT NULL DEFAULT 10;

ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS anonymous_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_anonymous_session
  ON conversations (workspace_id, anonymous_session_id)
  WHERE anonymous_session_id IS NOT NULL;
