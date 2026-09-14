-- A reaction's assessment and target message are one conversation-level fact.
-- Existing invalid provenance must stop this upgrade visibly rather than being
-- reassigned or deleted by a migration.
ALTER TABLE answer_coverage_assessments
  ADD CONSTRAINT answer_coverage_assessments_workspace_conversation_id_key
  UNIQUE (workspace_id, conversation_id, id);

ALTER TABLE answer_coverage_reaction_traces
  DROP CONSTRAINT answer_coverage_reaction_traces_workspace_id_assessment_id_fkey;

ALTER TABLE answer_coverage_reaction_traces
  ADD CONSTRAINT answer_coverage_reaction_traces_workspace_conversation_assessment_id_fkey
  FOREIGN KEY (workspace_id, conversation_id, assessment_id)
  REFERENCES answer_coverage_assessments(workspace_id, conversation_id, id)
  ON DELETE CASCADE;
