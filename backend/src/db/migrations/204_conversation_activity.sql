-- What people and the agent did to a conversation that operators follow: a handoff requested,
-- claimed, reassigned or handed back; an approval decided; negative feedback resolved or dismissed.
-- The module that owns each change writes its row in the same transaction as the change, so a
-- change never commits without its record, nor a record without its change. Operator-only: no
-- visitor surface reads it.
--
-- `actor_user_id` is the teammate who acted; null when the agent acted, or the change came from a
-- caller that is no teammate (an API token). `subject_user_id` is the teammate the change was about
-- (the new owner of a reassigned conversation). Both keep the event when the user is deleted.
--
-- `detail` carries ids and enum codes only — a handoff reason code, the previous owner's user id,
-- the decided option's id and label as the routine author wrote it, a triage resolution code —
-- never message content.
--
-- A new table, so creating its indexes takes no lock anything else waits on. No index on the user
-- columns: reads join `users` from the event, never the other way round, so deleting a user scans
-- for rows to null. User deletion is rare, so that scan is accepted rather than paying for two
-- indexes on every write.
CREATE TABLE IF NOT EXISTS conversation_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'handoff_requested',
    'claimed',
    'reassigned',
    'handed_back',
    'approval_decided',
    'feedback_resolved',
    'feedback_dismissed'
  )),
  actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- A conversation's timeline, oldest first.
CREATE INDEX IF NOT EXISTS conversation_activity_conversation_created_idx
  ON conversation_activity (conversation_id, created_at);

-- The Inbox's "recently closed": a workspace's latest closing events, newest first.
CREATE INDEX IF NOT EXISTS conversation_activity_workspace_closed_idx
  ON conversation_activity (workspace_id, created_at DESC)
  WHERE kind IN ('handed_back', 'approval_decided', 'feedback_resolved', 'feedback_dismissed');

-- The teammate who decided an approval. `decided_by` names the organisation the workspace belongs
-- to, which every teammate shares; this names the person. Null for decisions made before this
-- column, by a caller that is no teammate, or once the user is deleted. No index, for the same
-- reason as the activity table's user columns.
ALTER TABLE pending_decisions
  ADD COLUMN IF NOT EXISTS decided_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
