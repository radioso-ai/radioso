-- Conversation erasure (#1540): deleting a message clears its link on every usage event it recorded,
-- and the billing ledger is the largest table a message's cascade reaches. Without this index each
-- erased message scans it whole.
--
-- Locks. A plain CREATE INDEX holds SHARE until the file commits, which stops writes to the table for
-- the build; the wait for the lock is bounded to three seconds, and a deploy that hits it rolls back
-- whole and a retry is safe. One table per file, so nothing else is held while it builds.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name and predicate
-- (docs-portal/content/operators/deployment.mdx, "Conversation erasure keys"), so this finds it
-- already built. A concurrent build that failed leaves an invalid index of that name: drop it first.
SET LOCAL lock_timeout = '3s';

LOCK TABLE usage_events IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS usage_events_message_idx
  ON usage_events (message_id) WHERE message_id IS NOT NULL;
