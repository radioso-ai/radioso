CREATE TABLE IF NOT EXISTS assistant_answer_feedback (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  anonymous_session_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  value TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_answer_feedback_value_check
    CHECK (value IN ('up', 'down')),
  CONSTRAINT assistant_answer_feedback_actor_type_check
    CHECK (actor_type IN ('authenticated_user', 'api_token', 'anonymous_user')),
  CONSTRAINT assistant_answer_feedback_comment_check
    CHECK (comment IS NULL OR char_length(comment) <= 2000),
  CONSTRAINT assistant_answer_feedback_down_comment_check
    CHECK (value = 'down' OR comment IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_answer_feedback_actor_message
  ON assistant_answer_feedback (assistant_message_id, actor_type, actor_id);

CREATE INDEX IF NOT EXISTS idx_assistant_answer_feedback_workspace_message
  ON assistant_answer_feedback (workspace_id, assistant_message_id, created_at);

DO $$
BEGIN
  IF to_regclass('public.ee_assistant_answer_feedback') IS NOT NULL THEN
    INSERT INTO assistant_answer_feedback (
      id,
      workspace_id,
      conversation_id,
      assistant_message_id,
      account_id,
      user_id,
      anonymous_session_id,
      actor_type,
      actor_id,
      value,
      comment,
      created_at,
      updated_at
    )
    SELECT
      id,
      workspace_id,
      conversation_id,
      assistant_message_id,
      account_id,
      user_id,
      anonymous_session_id,
      actor_type,
      actor_id,
      value,
      comment,
      created_at,
      updated_at
    FROM ee_assistant_answer_feedback
    ON CONFLICT (assistant_message_id, actor_type, actor_id) DO NOTHING;
  END IF;
END
$$;
