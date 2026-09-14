-- The routine lifecycle collapse (migration 181) stopped the application from ever writing a
-- `status` transition again: every routine is inserted 'published' and stays there forever.
-- `block_webhook_destination_delete_if_published_reference` still gated its delete-block on
-- `status = 'published'`, so that condition became permanently true and disabling a routine
-- could no longer release a webhook destination it once held via completionExport. Gate on
-- `enabled` (mirroring `agent_skills.enabled`) and the canonical, highest-version row of a
-- lineage instead, matching what `listRoutineNamesReferencingDestination` now checks.
CREATE OR REPLACE FUNCTION block_webhook_destination_delete_if_published_reference()
RETURNS TRIGGER AS $$
DECLARE
  referencing_routine_names TEXT[];
BEGIN
  SELECT ARRAY_AGG(DISTINCT d.name ORDER BY d.name)
  INTO referencing_routine_names
  FROM routine_completion_export ce
  JOIN routine_definition d ON d.id = ce.definition_id
  JOIN agents a ON a.id = d.agent_id
  WHERE a.workspace_id = OLD.workspace_id
    AND d.enabled = TRUE
    AND d.version = (SELECT MAX(v.version) FROM routine_definition v WHERE v.lineage_id = d.lineage_id)
    AND ce.enabled = TRUE
    AND lower(ce.destination_ref) = OLD.id::text;

  IF COALESCE(array_length(referencing_routine_names, 1), 0) > 0 THEN
    RAISE EXCEPTION 'webhook destination % is referenced by enabled routines: %', OLD.id, array_to_string(referencing_routine_names, ', ')
      USING ERRCODE = '23503',
            CONSTRAINT = 'workspace_webhook_destinations_published_routine_reference';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
