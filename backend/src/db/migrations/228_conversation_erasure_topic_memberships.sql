-- Conversation erasure (#1540): deleting a message removes its Audience Pulse topic memberships, which
-- every census run writes again. Without this index each erased message scans them whole.
--
-- Locks. A plain CREATE INDEX holds SHARE until the file commits, which stops writes to the table for
-- the build; the wait for the lock is bounded to three seconds, and a deploy that hits it rolls back
-- whole and a retry is safe. One table per file, so nothing else is held while it builds.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name and predicate
-- (docs-portal/content/operators/deployment.mdx, "Conversation erasure keys"), so this finds it
-- already built. A concurrent build that failed leaves an invalid index of that name: drop it first.
SET LOCAL lock_timeout = '3s';

LOCK TABLE topic_memberships IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS topic_memberships_message_idx
  ON topic_memberships (message_id);
