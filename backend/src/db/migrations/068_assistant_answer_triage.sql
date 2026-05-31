-- Operator triage state for assistant turns on the Quality review surface.
-- One row per (workspace, assistant turn); absence of a row means "open".
CREATE TABLE IF NOT EXISTS assistant_answer_triage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, assistant_message_id),
  CONSTRAINT assistant_answer_triage_state_check
    CHECK (state IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  CONSTRAINT assistant_answer_triage_reason_check
    CHECK (reason IS NULL OR char_length(reason) <= 500)
);

-- Supports filtering a workspace's turns by triage state.
CREATE INDEX IF NOT EXISTS idx_assistant_answer_triage_workspace_state
  ON assistant_answer_triage (workspace_id, state);
