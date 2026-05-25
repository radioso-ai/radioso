ALTER TABLE messages
ADD COLUMN IF NOT EXISTS skill_name TEXT,
ADD COLUMN IF NOT EXISTS skill_outcome TEXT,
ADD COLUMN IF NOT EXISTS skill_status TEXT;

-- One-time historical backfill. New turns write messages.skill_* directly;
-- legacy skill-intake rows may only have audit metadata, so known historical
-- skill semantics are handled here instead of in chat runtime code.
UPDATE messages AS m
SET
  skill_name = COALESCE(
    e.metadata_json->'skillTurn'->>'skillName',
    e.metadata_json->>'skillName',
    e.metadata_json->'skillIntake'->>'skillName',
    CASE e.metadata_json->>'answerOutcome'
      WHEN 'grounded_success' THEN 'retrieval.answer'
      WHEN 'no_context_refusal' THEN 'retrieval.answer'
      WHEN 'non_retrieval_response' THEN 'assistant.chat'
      ELSE NULL
    END
  ),
  skill_outcome = COALESCE(
    e.metadata_json->'skillTurn'->>'outcome',
    e.metadata_json->>'skillOutcome',
    e.metadata_json->'skillIntake'->>'skillOutcome',
    CASE
      WHEN e.metadata_json->'skillIntake'->>'skillName' = 'human_contact.request'
        AND e.metadata_json->'skillIntake'->>'status' = 'completed' THEN 'sent'
      WHEN e.metadata_json->'skillIntake'->>'skillName' = 'human_contact.request'
        AND e.metadata_json->'skillIntake'->>'status' IN ('failed', 'cancelled')
        THEN e.metadata_json->'skillIntake'->>'status'
      WHEN e.metadata_json ? 'skillIntake' THEN 'unknown'
      ELSE NULL
    END,
    CASE e.metadata_json->>'answerOutcome'
      WHEN 'grounded_success' THEN 'grounded'
      WHEN 'no_context_refusal' THEN 'no_context'
      WHEN 'non_retrieval_response' THEN 'conversational'
      ELSE NULL
    END
  ),
  skill_status = COALESCE(
    e.metadata_json->'skillTurn'->>'status',
    e.metadata_json->>'skillStatus',
    e.metadata_json->'skillIntake'->>'status',
    CASE
      WHEN e.metadata_json ? 'answerOutcome' THEN 'completed'
      ELSE NULL
    END
  )
FROM audit_events AS e
WHERE m.role = 'assistant'
  AND m.skill_name IS NULL
  AND e.event_type = 'chat.answer'
  AND e.metadata_json->>'assistantMessageId' = m.id::text;

CREATE INDEX IF NOT EXISTS messages_workspace_skill_turn_idx
  ON messages (workspace_id, skill_name, skill_outcome, skill_status, created_at DESC);
