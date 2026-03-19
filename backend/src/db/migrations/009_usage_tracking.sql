CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY,
  operation_key TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  -- Conversation/message/document references intentionally remain nullable and
  -- unfkeyed so historical usage can outlive routine cleanup of those records.
  conversation_id UUID,
  user_message_id UUID,
  assistant_message_id UUID,
  document_id UUID,
  processing_job_id UUID,
  source_area TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  model TEXT NOT NULL,
  event_status TEXT NOT NULL,
  usage_available BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_account_occurred_at
  ON usage_events (account_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_assistant_message_id
  ON usage_events (assistant_message_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_occurred_at
  ON usage_events (workspace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS account_daily_usage_summaries (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  usage_event_count INTEGER NOT NULL DEFAULT 0,
  unavailable_event_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_account_daily_usage_summaries_account_date
  ON account_daily_usage_summaries (account_id, usage_date DESC);
