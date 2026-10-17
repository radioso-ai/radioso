-- Conversation erasure (#1540): a conversation's delivery rows cascade by conversation_id, and the
-- email channel's eraser finds the ones still reserved for it by planned_conversation_id.
--
-- Locks. A plain CREATE INDEX holds SHARE until the file commits, which stops writes to the table for
-- the build; the wait for the lock is bounded to three seconds, and a deploy that hits it rolls back
-- whole and a retry is safe. One table per file, so nothing else is held while it builds.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name and predicate
-- (docs-portal/content/operators/deployment.mdx, "Conversation erasure keys"), so this finds it
-- already built. A concurrent build that failed leaves an invalid index of that name: drop it first.
SET LOCAL lock_timeout = '3s';

LOCK TABLE email_inbound_deliveries IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS email_inbound_deliveries_conversation_idx
  ON email_inbound_deliveries (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_planned_conversation_idx
  ON email_inbound_deliveries (planned_conversation_id) WHERE planned_conversation_id IS NOT NULL;
