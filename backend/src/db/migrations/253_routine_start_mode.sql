-- How a routine starts once activation picks it (#1716). 'automatic' starts it on the match, as
-- every routine has until now; 'offer' starts it only when the visitor directly asked for what it
-- does, and otherwise answers the turn and offers to start it. Every existing routine reads back as
-- 'automatic', so none changes behaviour.
--
-- routine_offers remembers which routines a conversation was offered, so an Offer-first routine is
-- offered at most once per conversation. The pending offer itself lives in clarification_states,
-- whose one row per conversation the next clarification replaces; this memory outlives it. A row
-- holds two ids and a time, never visitor text. It follows its conversation: deleting the
-- conversation, by erasure or retention, deletes its rows. A turn writes its row in the same
-- transaction as the pending offer.
--
-- Locks. The whole file is one transaction. The new table's foreign key takes SHARE ROW EXCLUSIVE on
-- conversations for the instant the table is created, so it goes first, the way a chat turn writes
-- conversations before anything else. ADD COLUMN with a constant default is catalog-only, and the
-- CHECK is validated against existing rows (all 'automatic'); both hold ACCESS EXCLUSIVE on
-- routine_definition for milliseconds. The wait for each lock is bounded to three seconds; a deploy
-- that hits it rolls back and a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS routine_offers (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  routine_id TEXT NOT NULL,
  offered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, routine_id)
);

ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS activation_start_mode TEXT NOT NULL DEFAULT 'automatic';

ALTER TABLE routine_definition
  DROP CONSTRAINT IF EXISTS routine_definition_activation_start_mode_check;

ALTER TABLE routine_definition
  ADD CONSTRAINT routine_definition_activation_start_mode_check
  CHECK (activation_start_mode IN ('automatic', 'offer'));
