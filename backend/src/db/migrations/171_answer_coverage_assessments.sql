CREATE UNIQUE INDEX idx_conversations_workspace_id_unique ON conversations (workspace_id, id);
CREATE UNIQUE INDEX idx_messages_workspace_conversation_id_unique ON messages (workspace_id, conversation_id, id);

-- A session can host many routine runs over time. This identifier distinguishes
-- the concrete run that consumed a coverage signal from its routine definition.
ALTER TABLE routine_states ADD COLUMN IF NOT EXISTS execution_id UUID;

CREATE TABLE answer_coverage_assessments (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  request_message_id UUID NOT NULL,
  originating_turn_id UUID NOT NULL,
  contextualized_request TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('assessed', 'not_recorded', 'failed', 'invalid')),
  coverage TEXT CHECK (coverage IN ('answered', 'partial', 'unanswered', 'unclear')),
  reason TEXT CHECK (reason IN ('sufficient_evidence', 'insufficient_evidence', 'conflicting_evidence', 'ambiguous_request', 'intentional_scope_boundary')),
  unresolved_request TEXT,
  schema_version INTEGER NOT NULL,
  interaction_evaluation_state TEXT CHECK (interaction_evaluation_state IN ('evaluated')),
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_message_id),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id, request_message_id) REFERENCES messages(workspace_id, conversation_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id, originating_turn_id) REFERENCES messages(workspace_id, conversation_id, id) ON DELETE CASCADE,
  CHECK (
    (availability = 'assessed' AND coverage IS NOT NULL AND reason IS NOT NULL)
    OR (availability <> 'assessed' AND coverage IS NULL AND reason IS NULL AND unresolved_request IS NULL)
  )
);

CREATE INDEX answer_coverage_assessments_workspace_conversation_idx
  ON answer_coverage_assessments (workspace_id, conversation_id, assessed_at);

CREATE TABLE answer_coverage_reaction_traces (
  id UUID PRIMARY KEY,
  assessment_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  reaction_key TEXT NOT NULL,
  directive_id UUID,
  routine_id UUID,
  routine_execution_id UUID,
  target_message_id UUID NOT NULL,
  evaluation_state TEXT NOT NULL CHECK (evaluation_state IN ('evaluated', 'not_applicable', 'suppressed')),
  evaluation_index INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('matched', 'applied', 'offered', 'activated', 'skipped', 'suppressed')),
  reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (assessment_id, reaction_key),
  CHECK (evaluation_index >= 0),
  FOREIGN KEY (workspace_id, assessment_id) REFERENCES answer_coverage_assessments(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, conversation_id, target_message_id) REFERENCES messages(workspace_id, conversation_id, id) ON DELETE CASCADE
);

CREATE INDEX answer_coverage_reaction_traces_assessment_idx
  ON answer_coverage_reaction_traces (assessment_id, created_at);
