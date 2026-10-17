-- Conversation erasure (#1540), pending approvals: both columns name the conversation (the session id
-- is the routine state's, which is the conversation's), and either one's key cascades. Rows whose
-- conversation is gone are removed by 229, which validates the keys.
--
-- Locks. Migrations run at API boot while the previous revision still serves, each file in one
-- transaction, so each erasure key takes its own file: two live writers take these tables in opposite
-- orders (a chat turn writes the outbox before its pending decision; resolving a decision writes the
-- decision first), and one file holding two of them could deadlock with either. The wait for each lock
-- is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe. The table
-- itself is locked first, then the key reaches `conversations` last, as a chat turn does: it writes its
-- rows before it touches the conversation.
SET LOCAL lock_timeout = '3s';

LOCK TABLE pending_decisions IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS pending_decisions_conversation_idx ON pending_decisions (conversation_id);
CREATE INDEX IF NOT EXISTS pending_decisions_session_idx ON pending_decisions (session_id);

ALTER TABLE pending_decisions
  ADD CONSTRAINT pending_decisions_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT pending_decisions_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;
