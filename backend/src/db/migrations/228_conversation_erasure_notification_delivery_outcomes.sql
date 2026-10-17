-- Conversation erasure (#1540), the notice email cap's ledger: deleting a conversation must not hand its
-- emails back to the day's budget, so a row keeps its counts and loses the link. Dropping NOT NULL is a
-- catalog change; 229 clears the links of conversations already gone and validates the key.
--
-- Locks. Migrations run at API boot while the previous revision still serves, each file in one
-- transaction, so each erasure key takes its own file: two live writers take these tables in opposite
-- orders (a chat turn writes the outbox before its pending decision; resolving a decision writes the
-- decision first), and one file holding two of them could deadlock with either. The wait for each lock
-- is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe. The table
-- itself is locked first, then the key reaches `conversations` last, as a chat turn does: it writes its
-- rows before it touches the conversation.
--
-- Dropping NOT NULL needs ACCESS EXCLUSIVE, so the table is locked that way from the start: taking a
-- weaker lock first and upgrading it would wait on a notice reservation that read the table and is
-- itself waiting to write it.
SET LOCAL lock_timeout = '3s';

LOCK TABLE notification_delivery_outcomes IN ACCESS EXCLUSIVE MODE;

ALTER TABLE notification_delivery_outcomes
  ALTER COLUMN conversation_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS notification_delivery_outcomes_conversation_link_idx
  ON notification_delivery_outcomes (conversation_id) WHERE conversation_id IS NOT NULL;

ALTER TABLE notification_delivery_outcomes
  ADD CONSTRAINT notification_delivery_outcomes_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL NOT VALID;
