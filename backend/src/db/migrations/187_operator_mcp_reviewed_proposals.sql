ALTER TABLE copilot_proposals
  ADD COLUMN review_digest TEXT NULL,
  ADD COLUMN review_snapshot JSONB NULL,
  ADD COLUMN expires_at TIMESTAMPTZ NULL,
  ADD COLUMN execution_invocation_id UUID NULL
    REFERENCES operator_mcp_invocations(id) ON DELETE RESTRICT;

ALTER TABLE copilot_proposals
  DROP CONSTRAINT copilot_proposals_target_type_check;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_target_type_check
  CHECK (target_type IN ('directive', 'agent', 'agent_setting', 'routine', 'agent_skill', 'context_variable', 'document', 'ingestion_settings', 'website_crawl', 'workspace_setting', 'agent_publication'));

CREATE UNIQUE INDEX copilot_proposals_execution_invocation_idx
  ON copilot_proposals (execution_invocation_id)
  WHERE execution_invocation_id IS NOT NULL;

CREATE INDEX copilot_proposals_reviewed_expiry_idx
  ON copilot_proposals (expires_at, id)
  WHERE review_digest IS NOT NULL AND status = 'pending';
