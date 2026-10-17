-- Conversation erasure (#1540), the queued routine actions: a notice or post queued for a conversation
-- goes with it. Rows whose conversation is gone are removed by 229, which validates the key.
--
-- Locks. Migrations run at API boot while the previous revision still serves, each file in one
-- transaction, so each erasure key takes its own file: two live writers take these tables in opposite
-- orders (a chat turn writes the outbox before its pending decision; resolving a decision writes the
-- decision first), and one file holding two of them could deadlock with either. The wait for each lock
-- is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe. The table
-- itself is locked first, then the key reaches `conversations` last, as a chat turn does: it writes its
-- rows before it touches the conversation.
--
-- On a table over 100k rows, build the index `CONCURRENTLY` first under the same name and predicate
-- (docs-portal/content/operators/deployment.mdx, "Conversation erasure keys"), so this finds it and
-- only adds the key. A concurrent build that failed leaves an invalid index of that name: drop it first.
SET LOCAL lock_timeout = '3s';

LOCK TABLE routine_action_requests IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS routine_action_requests_conversation_idx
  ON routine_action_requests (conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE routine_action_requests
  ADD CONSTRAINT routine_action_requests_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;
