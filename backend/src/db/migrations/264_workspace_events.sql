-- The workspace event log (#1851): business events an automation acts on, recorded in the same
-- transaction as the change they describe and listed by a cursor. The module that owns each change
-- writes its row through the recorder port, so a change never commits without its event, nor an
-- event without its change.
--
-- Ordering. `position` is drawn at insert, but transactions commit in any order, so a reader that
-- paged by position alone could pass a row that commits later with a smaller number. `tx_id` is the
-- writing transaction's id. A read returns only rows whose transaction is older than every
-- transaction still running (`pg_snapshot_xmin(pg_current_snapshot())`), ordered by
-- (`tx_id`, `position`): nothing can commit below that horizon any more, so a cursor never passes a
-- row that is yet to appear. A long write transaction delays newer rows; it never hides them.
--
-- `data` carries ids, enum codes and the values an automation acts on (contact details a visitor
-- submitted, a routine's declared slot values with sensitive ones masked), never a transcript.
-- The conversation columns are copied from the conversation row when the event is recorded.
--
-- Erasure. Rows go with their conversation (composite key, ON DELETE CASCADE) and with their
-- workspace, so erasing a conversation or a visitor, the workspace's own retention window, and
-- workspace deletion remove them. A fixed 30-day window removes the rest.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on `workspaces` and `conversations` until the
-- migration commits: writes to them wait, reads do not. The table is new and empty, so the migration
-- takes milliseconds. The wait for each lock is bounded to three seconds; a deploy that hits it rolls
-- back and a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE workspace_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position BIGINT GENERATED ALWAYS AS IDENTITY,
  tx_id XID8 NOT NULL DEFAULT pg_current_xact_id(),
  type TEXT NOT NULL CHECK (type ~ '^[a-z_]+\.[a-z_]+$'),
  version SMALLINT NOT NULL CHECK (version > 0),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT NULL CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 300),
  conversation_id UUID NULL,
  agent_id UUID NULL,
  channel TEXT NULL,
  caller_kind TEXT NULL,
  visitor_id UUID NULL,
  data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
);

-- The log in commit-safe order, whole and by type.
CREATE INDEX workspace_events_log_idx ON workspace_events (workspace_id, tx_id, position);
CREATE INDEX workspace_events_type_log_idx ON workspace_events (workspace_id, type, tx_id, position);

-- A writer that may record the same fact twice names it, and the second write is dropped.
CREATE UNIQUE INDEX workspace_events_idempotency_idx
  ON workspace_events (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The cascade from an erased conversation, and the consent withholder, find a conversation's rows.
CREATE INDEX workspace_events_conversation_idx ON workspace_events (conversation_id) WHERE conversation_id IS NOT NULL;

-- The retention window removes rows by age across every workspace.
CREATE INDEX workspace_events_occurred_at_idx ON workspace_events (occurred_at);
