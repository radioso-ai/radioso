-- The Inbox's "recently closed" index, extended with the email channel's two closing kinds: a held
-- reply released, and a delivery failure cleared. It replaces conversation_activity_workspace_closed_idx
-- (205), which stays until every running version reads through this one; 217 drops it.
--
-- Locks. CREATE INDEX takes SHARE on conversation_activity for the build: reads continue, activity
-- writes wait until it commits. Its wait for the lock is bounded to three seconds, as 211's is. When
-- the table is large (over 100k rows), the deploy runbook builds this index first with
-- CREATE INDEX CONCURRENTLY under the same name and predicate, so this migration finds it and does
-- nothing; a concurrent build that failed leaves an invalid index of this name, which must be dropped
-- before the deploy.
SET LOCAL lock_timeout = '3s';

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
