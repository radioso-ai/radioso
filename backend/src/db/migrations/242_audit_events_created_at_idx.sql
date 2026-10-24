-- Audit event retention (#1609): the sweep in `conversationRetention.ts` deletes audit events past
-- their fixed window by age alone, across every workspace and the orphaned events a deleted
-- workspace left behind (`workspace_id` set NULL by migration 007). Every existing index on this
-- table leads with `workspace_id`, or filters by `event_type`, so a sweep by age alone would scan
-- the table whole.
--
-- Locks. A plain CREATE INDEX holds SHARE until the file commits, which stops writes to the table
-- for the build; the wait for the lock is bounded to three seconds, and a deploy that hits it rolls
-- back whole and a retry is safe.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name
-- (docs-portal/content/operators/deployment.mdx, "Conversation erasure keys", is the precedent for
-- this), so this migration finds it already built:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at);
--
-- A concurrent build that failed leaves an invalid index of that name; drop it before retrying.
SET LOCAL lock_timeout = '3s';

LOCK TABLE audit_events IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at);
