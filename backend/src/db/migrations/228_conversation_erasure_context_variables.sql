-- Conversation erasure (#1540): context variables named their workspace without a key, so a deleted
-- workspace left its variables behind, and with them every value a host pushed for a session or a
-- verified customer. They cascade from the workspace from here on. Variables whose workspace is gone
-- are removed by 229, which validates the key. The unique (workspace_id, name) index serves the cascade.
--
-- Locks. Migrations run at API boot while the previous revision still serves, each file in one
-- transaction, so each erasure key takes its own file: two live writers take these tables in opposite
-- orders (a chat turn writes the outbox before its pending decision; resolving a decision writes the
-- decision first), and one file holding two of them could deadlock with either. The wait for each lock
-- is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe. The table
-- itself is locked first, then the key reaches `workspaces` last, as a chat turn does: it writes its
-- rows before it touches the conversation.
SET LOCAL lock_timeout = '3s';

LOCK TABLE context_variables IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE context_variables
  ADD CONSTRAINT context_variables_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
