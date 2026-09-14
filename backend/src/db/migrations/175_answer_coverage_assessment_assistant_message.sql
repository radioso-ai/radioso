-- An assessment is provisional until the canonical assistant-turn transaction
-- commits the exact reply that it evaluated. Keep existing rows unconfirmed: no
-- timestamp or audit-event inference can safely recover that association.
ALTER TABLE answer_coverage_assessments
  ADD COLUMN assistant_message_id uuid;

ALTER TABLE answer_coverage_assessments
  ADD CONSTRAINT answer_coverage_assessments_conversation_assistant_message_fkey
  FOREIGN KEY (workspace_id, conversation_id, assistant_message_id)
  REFERENCES messages(workspace_id, conversation_id, id)
  ON DELETE SET NULL (assistant_message_id);
