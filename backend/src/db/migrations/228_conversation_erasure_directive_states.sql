-- Conversation erasure (#1540), directive firing memory goes with the conversation. The primary key
-- already indexes the column. Rows whose conversation is gone are removed by 229, which validates the key.
--
-- Locks. Migrations run at API boot while the previous revision still serves, each file in one
-- transaction, so each erasure key takes its own file: two live writers take these tables in opposite
-- orders (a chat turn writes the outbox before its pending decision; resolving a decision writes the
-- decision first), and one file holding two of them could deadlock with either. The wait for each lock
-- is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe. The table
-- itself is locked first, then the key reaches `conversations` last, as a chat turn does: it writes its
-- rows before it touches the conversation.
SET LOCAL lock_timeout = '3s';

LOCK TABLE directive_states IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE directive_states
  ADD CONSTRAINT directive_states_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;
