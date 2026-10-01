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
-- Locks. The table's foreign keys take SHARE ROW EXCLUSIVE on `conversations` and `users`, and
-- adding `pending_decisions.decided_by_user_id` below takes ACCESS EXCLUSIVE on `pending_decisions`
-- (and SHARE ROW EXCLUSIVE on `users` again). A migration runs in one transaction, so each holds until
-- it commits: writes to conversations and users wait, reads of them do not, and every access to
-- pending_decisions waits. The migration takes milliseconds, so the wait is brief — the same locks
-- migration 203's `ADD COLUMN ... REFERENCES users` took. That column is added last, so the backfill
-- never runs while pending_decisions is locked. The indexes are built on the new, near-empty table.
--
-- No index on the user columns: reads join `users` from the event, never the other way round, so
-- deleting a user scans for rows to null. User deletion is rare, so that scan is accepted rather than
-- paying for two indexes on every write.
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

-- Feedback closed in the last 30 days, from the triage history, so the Inbox's "Recently closed" and
-- each conversation's timeline carry it from the first read. Only the transitions that closed the
-- feedback — into resolved or dismissed from another state — as the live writer records them; a
-- re-save of a closed state closes nothing. Handoffs and approvals leave no history to rebuild them
-- from. Test chats are backfilled too, as the live writer records their closures; the reads that
-- leave operator test traffic out (the Inbox's "Recently closed") filter it themselves.
--
-- A closure is identified by the triage transition that produced it (`detail->>'triageTransitionId'`),
-- never by `created_at`: the live writer stamps its row with its own `clock_timestamp()`, milliseconds
-- after the transition's own timestamp, so the two never compare equal. `NOT EXISTS` on the transition
-- id keeps a re-run of this migration, or a backfill that runs after the live writer already recorded
-- the same transition, from recording the closure twice.
--
-- The 30-day bound keeps the backfill to recent history, and the transitions index on (workspace_id,
-- created_at) lets it read only those days, one workspace at a time. The guard's per-conversation scan
-- stays cheap without a new index: `conversation_activity_conversation_created_idx` (conversation_id,
-- created_at) narrows it to one conversation's handful of events before the detail comparison runs —
-- an EXPLAIN against a workspace with thousands of transitions and a conversation with a dozen prior
-- activity rows shows an index scan on that index, not a sequential scan. Every other join is by key,
-- so the whole backfill runs in milliseconds while it holds the locks above.
INSERT INTO conversation_activity (
    conversation_id, workspace_id, kind, actor_user_id, detail, created_at
  )
SELECT c.id,
       c.workspace_id,
       CASE t.next_state WHEN 'resolved' THEN 'feedback_resolved' ELSE 'feedback_dismissed' END,
       t.actor_id,
       jsonb_build_object(
         'assistantMessageId', t.assistant_message_id,
         'triageTransitionId', t.id,
         'resolution', t.resolution_reason
       ),
       t.created_at
  FROM workspaces w
  JOIN assistant_answer_triage_transitions t
    ON t.workspace_id = w.id
   AND t.created_at >= now() - interval '30 days'
  JOIN messages m
    ON m.workspace_id = t.workspace_id
   AND m.id = t.assistant_message_id
  JOIN conversations c
    ON c.id = m.conversation_id
 WHERE t.next_state IN ('resolved', 'dismissed')
   AND t.prior_state <> t.next_state
   AND NOT EXISTS (
     SELECT 1
       FROM conversation_activity a
      WHERE a.conversation_id = c.id
        AND a.kind IN ('feedback_resolved', 'feedback_dismissed')
        AND a.detail->>'triageTransitionId' = t.id::text
   );

-- The teammate who decided an approval. `decided_by` names the organisation the workspace belongs
-- to, which every teammate shares; this names the person. Null for decisions made before this
-- column, by a caller that is no teammate, or once the user is deleted. No index, for the same
-- reason as the activity table's user columns.
ALTER TABLE pending_decisions
  ADD COLUMN IF NOT EXISTS decided_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
