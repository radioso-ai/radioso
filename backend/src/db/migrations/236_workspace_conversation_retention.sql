-- Conversation retention (#1541): how many days a workspace keeps a conversation after its last
-- activity. Null keeps every conversation until someone deletes it, so this migration deletes
-- nothing: an operator opts a workspace in. The range is the one the settings API accepts. The sweep
-- records when it last reached the workspace, and starts each run with the ones reached longest ago,
-- so a run that ends on its budget hands the rest to the next one.
--
-- Locks. Migrations run at API boot while the previous revision still serves. Nullable columns with
-- no default are a catalog change, and the check scans only `workspaces`, one row per workspace.
-- The wait for the lock is bounded to three seconds; a deploy that hits it rolls back and a retry is
-- safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS conversation_retention_days INTEGER
  CONSTRAINT workspaces_conversation_retention_days_check
  CHECK (conversation_retention_days IS NULL OR conversation_retention_days BETWEEN 7 AND 3650),
  ADD COLUMN IF NOT EXISTS conversation_retention_swept_at TIMESTAMPTZ;
