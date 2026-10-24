-- Audit event retention (#1609): the sweep in `conversationRetention.ts` deletes audit events past
-- their fixed window by age alone, across every workspace and the orphaned events a deleted
-- workspace left behind (`workspace_id` set NULL by migration 007). Every existing index on this
-- table leads with `workspace_id`, or filters by `event_type`, so a sweep by age alone would scan
-- the table whole.
--
-- Locks. Migrations run with statement_timeout = 0: the three-second lock_timeout below only bounds
-- the wait to *acquire* the table lock, so a deploy that hits that rolls back whole and a retry is
-- safe. Once acquired, a plain CREATE INDEX holds SHARE for as long as the build takes, with no time
-- bound, blocking every chat turn's audit insert for that whole duration.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name
-- (docs-portal/content/operators/deployment.mdx, "Audit event retention index"), so this migration
-- finds it already built:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at);
--
-- A concurrent build that failed leaves an invalid index of that name behind. `CREATE INDEX IF NOT
-- EXISTS` only checks the name, not validity, so it would otherwise treat that invalid index as done
-- rather than replace it; the guard below raises instead, so the deploy fails loudly and the
-- operator drops it (`DROP INDEX CONCURRENTLY audit_events_created_at_idx`) before retrying.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE c.relname = 'audit_events_created_at_idx' AND NOT i.indisvalid
  ) THEN
    RAISE EXCEPTION 'audit_events_created_at_idx exists but is invalid (a CONCURRENTLY build failed); run DROP INDEX CONCURRENTLY audit_events_created_at_idx and retry';
  END IF;
END $$;

SET LOCAL lock_timeout = '3s';

LOCK TABLE audit_events IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at);
