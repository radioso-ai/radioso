-- Sibling fix to migration 182. `enforce_published_routine_completion_export_destination` still
-- gated on `d.status = 'published'`, which migration 181 made unconditionally true for every
-- routine forever (every insert hardcodes 'published' to satisfy the now-vestigial CHECK
-- constraint). Combined with 182 correctly letting a disabled routine's webhook destination be
-- deleted, this was an unsaveable-routine trap: once a disabled routine's destination is gone,
-- ANY later edit to that routine goes through replaceChildren, which unconditionally deletes and
-- reinserts its routine_completion_export row, retriggering this still-always-on check against a
-- destination that no longer exists. Gate on `enabled` and canonical-row-ness instead, matching
-- 182's sibling trigger and `listRoutineNamesReferencingDestination`.
CREATE OR REPLACE FUNCTION enforce_published_routine_completion_export_destination()
RETURNS TRIGGER AS $$
DECLARE
  definition_workspace_id UUID;
  definition_enabled BOOLEAN;
  definition_canonical BOOLEAN;
  destination_exists BOOLEAN;
BEGIN
  IF NEW.enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT a.workspace_id, d.enabled,
         d.version = (SELECT MAX(v.version) FROM routine_definition v WHERE v.lineage_id = d.lineage_id)
  INTO definition_workspace_id, definition_enabled, definition_canonical
  FROM routine_definition d
  JOIN agents a ON a.id = d.agent_id
  WHERE d.id = NEW.definition_id;

  IF definition_enabled IS NOT TRUE OR definition_canonical IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT TRUE
  INTO destination_exists
  FROM workspace_webhook_destinations destination
  WHERE destination.workspace_id = definition_workspace_id
    AND destination.id::text = lower(NEW.destination_ref)
  FOR KEY SHARE;

  IF destination_exists IS NOT TRUE THEN
    RAISE EXCEPTION 'published routine completion export references unknown webhook destination %', NEW.destination_ref
      USING ERRCODE = '23503',
            CONSTRAINT = 'routine_completion_export_destination_ref_published_fk';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
