-- Evidence Ray measured before drafting a proposal: one row per eval case replayed against a
-- configuration that was not live. The copilot owns this rather than the eval module because the
-- identity that makes a measurement citable — which operator ran it, in which thread, against
-- which agent and at which configuration version — is a copilot concept.
CREATE TABLE copilot_replay_evidence (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operator_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES copilot_conversations(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES eval_cases(id) ON DELETE CASCADE,
  case_name TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  -- The agent's configuration version at replay time. A proposal drafted after the agent moved
  -- carries evidence that describes a configuration the operator is no longer looking at.
  agent_version_token TEXT NOT NULL,
  -- The case's recorded verdict before the replay, and what the replayed configuration produced.
  recorded_status TEXT NOT NULL CHECK (recorded_status IN ('pending', 'passing', 'failing', 'error')),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'error', 'recorded')),
  overrides JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX copilot_replay_evidence_operator_created_idx
  ON copilot_replay_evidence (workspace_id, operator_user_id, created_at DESC);

-- Evidence copied onto the proposal at draft time. The rows above stay the audit trail; the
-- proposal holds what the operator reviewed, so the card does not depend on rows that may be
-- cascaded away with their case.
ALTER TABLE copilot_proposals
  ADD COLUMN evidence JSONB NULL;
