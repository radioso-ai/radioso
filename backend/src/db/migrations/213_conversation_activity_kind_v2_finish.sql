-- The last of three steps widening conversation_activity.kind (211, 212): drops the original CHECK, so
-- the validated v2 CHECK alone holds the vocabulary and the email channel's kinds can be written.
--
-- Then the Inbox's "recently closed" index, extended with the email channel's two closing kinds: a
-- held reply released, and a delivery failure cleared. It replaces
-- conversation_activity_workspace_closed_idx (205), which stays until every running version reads
-- through this one; a later migration drops it.
--
-- Locks. DROP CONSTRAINT takes ACCESS EXCLUSIVE on conversation_activity, bounded to a three-second
-- wait as 211 is. One transaction holds that lock until it commits, so it also covers the index build:
-- Inbox reads and activity writes wait for the build. When the table is large (over 100k rows), the
-- deploy runbook builds the index first with CREATE INDEX CONCURRENTLY under the same name and
-- predicate, so this migration finds it and only drops the CHECK; a concurrent build that failed
-- leaves an invalid index of this name, which must be dropped before the deploy.
SET LOCAL lock_timeout = '3s';

ALTER TABLE conversation_activity
  DROP CONSTRAINT IF EXISTS conversation_activity_kind_check;

CREATE INDEX IF NOT EXISTS conversation_activity_workspace_closed_v2_idx
  ON conversation_activity (workspace_id, created_at DESC)
  WHERE kind IN (
    'handed_back',
    'approval_decided',
    'feedback_resolved',
    'feedback_dismissed',
    'held_reply_released',
    'delivery_failure_cleared'
  );
