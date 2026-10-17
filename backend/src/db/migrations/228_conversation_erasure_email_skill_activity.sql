-- Conversation erasure (#1540): the email skill activity eraser finds a conversation's rows by this.
--
-- Locks. A plain CREATE INDEX holds SHARE until the file commits, which stops writes to the table for
-- the build; the wait for the lock is bounded to three seconds, and a deploy that hits it rolls back
-- whole and a retry is safe. One table per file, so nothing else is held while it builds.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name and predicate
-- (docs-portal/content/operators/deployment.mdx, "Conversation erasure keys"), so this finds it
-- already built. A concurrent build that failed leaves an invalid index of that name: drop it first.
SET LOCAL lock_timeout = '3s';

LOCK TABLE email_skill_activity IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS email_skill_activity_conversation_idx
  ON email_skill_activity (workspace_id, conversation_id) WHERE conversation_id IS NOT NULL;
