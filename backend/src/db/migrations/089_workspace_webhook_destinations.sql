CREATE TABLE IF NOT EXISTS workspace_webhook_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL,
  last_delivery_status TEXT NULL,
  last_delivery_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CHECK (NULLIF(BTRIM(url), '') IS NOT NULL),
  CHECK (
    url ~* '^https://'
    OR url ~* '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$)'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_webhook_destinations_workspace_lower_name
  ON workspace_webhook_destinations (workspace_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_workspace_webhook_destinations_workspace_id
  ON workspace_webhook_destinations (workspace_id);

CREATE TABLE IF NOT EXISTS routine_completion_export (
  definition_id UUID PRIMARY KEY REFERENCES routine_definition(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  trigger_kinds TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  destination_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (array_length(trigger_kinds, 1) IS NULL OR trigger_kinds <@ ARRAY['complete', 'handoff']::TEXT[])
);

CREATE INDEX IF NOT EXISTS idx_routine_completion_export_destination_ref
  ON routine_completion_export (lower(destination_ref))
  WHERE enabled = TRUE;

CREATE OR REPLACE FUNCTION enforce_published_routine_completion_export_destination()
RETURNS TRIGGER AS $$
DECLARE
  definition_workspace_id UUID;
  definition_status TEXT;
  destination_exists BOOLEAN;
BEGIN
  IF NEW.enabled IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT a.workspace_id, d.status
  INTO definition_workspace_id, definition_status
  FROM routine_definition d
  JOIN agents a ON a.id = d.agent_id
  WHERE d.id = NEW.definition_id;

  IF definition_status IS DISTINCT FROM 'published' THEN
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

DROP TRIGGER IF EXISTS trg_routine_completion_export_destination
  ON routine_completion_export;

CREATE TRIGGER trg_routine_completion_export_destination
BEFORE INSERT OR UPDATE OF definition_id, enabled, destination_ref
ON routine_completion_export
FOR EACH ROW
EXECUTE FUNCTION enforce_published_routine_completion_export_destination();

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
    AND d.status = 'published'
    AND ce.enabled = TRUE
    AND lower(ce.destination_ref) = OLD.id::text;

  IF COALESCE(array_length(referencing_routine_names, 1), 0) > 0 THEN
    RAISE EXCEPTION 'webhook destination % is referenced by published routines: %', OLD.id, array_to_string(referencing_routine_names, ', ')
      USING ERRCODE = '23503',
            CONSTRAINT = 'workspace_webhook_destinations_published_routine_reference';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workspace_webhook_destinations_block_published_reference
  ON workspace_webhook_destinations;

CREATE TRIGGER trg_workspace_webhook_destinations_block_published_reference
BEFORE DELETE
ON workspace_webhook_destinations
FOR EACH ROW
EXECUTE FUNCTION block_webhook_destination_delete_if_published_reference();
