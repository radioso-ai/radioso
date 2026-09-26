ALTER TABLE copilot_proposals
  DROP CONSTRAINT copilot_proposals_target_type_check;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_target_type_check
  CHECK (target_type IN ('directive', 'agent', 'agent_setting', 'routine', 'agent_skill', 'context_variable', 'document', 'document_operation', 'ingestion_settings', 'website_crawl', 'workspace_setting', 'agent_publication', 'agent_greeting'));
