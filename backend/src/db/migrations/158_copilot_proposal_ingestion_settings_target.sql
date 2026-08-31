ALTER TABLE copilot_proposals
  DROP CONSTRAINT copilot_proposals_target_type_check;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_target_type_check
  CHECK (target_type IN ('directive', 'agent_setting', 'routine', 'agent_skill', 'context_variable', 'document', 'ingestion_settings'));
