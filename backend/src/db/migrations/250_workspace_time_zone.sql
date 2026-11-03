-- The zone a workspace reads "today" in (#1600), so "tomorrow" or "this weekend" in a question
-- means the visitor's tomorrow: the rewrite, answer and rerank prompts and the range lookup read
-- today's date in it. A visitor whose browser reports a zone overrides it for their own turns.
-- Null reads today in UTC, so this migration changes no workspace's answers. The application
-- validates the name against the runtime's IANA zone data; the check only bounds its length.
-- Ray proposes the setting as its own target type.
--
-- Locks. Migrations run at API boot while the previous revision still serves, and the whole file
-- is one transaction, so every lock it takes is held until it commits. Replacing the proposal
-- target check scans `copilot_proposals`, as every target type added before this one did, so it
-- runs first: `workspaces`, which nearly every request reads, is locked last, and only for its own
-- change. A nullable column with no default is a catalog change; its check scans only
-- `workspaces`, one row per workspace. The wait for each lock is bounded to three seconds; a
-- deploy that hits it rolls back and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE copilot_proposals
  DROP CONSTRAINT copilot_proposals_target_type_check;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_target_type_check
  CHECK (target_type IN ('directive', 'agent', 'agent_setting', 'routine', 'agent_skill', 'context_variable', 'document', 'document_operation', 'ingestion_settings', 'website_crawl', 'workspace_setting', 'agent_publication', 'agent_greeting', 'privacy_setting', 'time_zone_setting'));

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS time_zone TEXT
  CONSTRAINT workspaces_time_zone_check
  CHECK (time_zone IS NULL OR length(time_zone) BETWEEN 1 AND 64);
