ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS answer_outcome TEXT;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_answer_outcome_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_answer_outcome_check
  CHECK (
    answer_outcome IS NULL
    OR answer_outcome IN ('grounded_success', 'no_context_refusal', 'non_retrieval_response')
  );

-- Partial index for the quality dashboard's list-and-filter read path.
-- Only assistant messages with a recorded outcome are interesting; index stays small.
CREATE INDEX IF NOT EXISTS idx_messages_workspace_answer_outcome
  ON messages (workspace_id, answer_outcome, created_at DESC)
  WHERE answer_outcome IS NOT NULL;

-- Backfill from existing audit events. The outcome was previously only persisted
-- inside audit_events.metadata_json; pull it onto messages so the read path can
-- filter without scanning JSONB. Rows older than audit-event retention (none today)
-- stay NULL, which the dashboard's outcome filter excludes — safe.
UPDATE messages m
SET answer_outcome = ae.metadata_json ->> 'answerOutcome'
FROM audit_events ae
WHERE ae.event_type = 'chat.answer'
  AND ae.metadata_json ->> 'assistantMessageId' = m.id::text
  AND ae.metadata_json ->> 'answerOutcome' IN (
    'grounded_success',
    'no_context_refusal',
    'non_retrieval_response'
  )
  AND m.answer_outcome IS NULL;
