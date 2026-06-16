-- Feature 089 follow-up: move all configuration-backed skill definitions onto
-- generic agent_skills.target_type / target_id / config columns.
--
-- 099/100 have already shipped and are tracked by filename in schema_migrations.
-- Keep them immutable; this forward migration upgrades databases that already
-- ran the original detail-table shape and also works for fresh databases.

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS target_type TEXT NULL,
  ADD COLUMN IF NOT EXISTS target_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

UPDATE agent_skills
SET config = '{}'::jsonb
WHERE config IS NULL;

ALTER TABLE agent_skills
  ALTER COLUMN config SET DEFAULT '{}'::jsonb,
  ALTER COLUMN config SET NOT NULL;

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_kind_check;

DO $$
BEGIN
  IF to_regclass(format('%I.external_skill_details', current_schema())) IS NOT NULL THEN
    UPDATE agent_skills s
    SET
      target_type = 'mcp_connection',
      target_id = d.connection_id::text,
      config = jsonb_build_object(
        'toolName', d.tool_name,
        'boundParams', COALESCE(d.bound_params, '{}'::jsonb),
        'exposedParams', COALESCE(d.exposed_params, '{}'::jsonb),
        'declaredOutcomes', to_jsonb(d.declared_outcomes),
        'outcomeMap', d.outcome_map
      )
    FROM external_skill_details d
    WHERE d.skill_id = s.id
      AND s.kind = 'external_mcp';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass(format('%I.email_skill_details', current_schema())) IS NOT NULL THEN
    UPDATE agent_skills s
    SET
      target_type = 'customer_email_connection',
      target_id = d.connection_id::text,
      config = jsonb_build_object(
        'mode', d.mode,
        'boundInputs', COALESCE(d.bound_inputs, '{}'::jsonb),
        'exposedInputs', COALESCE(d.exposed_inputs, '{}'::jsonb)
      )
    FROM email_skill_details d
    WHERE d.skill_id = s.id
      AND s.kind = 'customer_email';
  END IF;
END $$;

DROP TABLE IF EXISTS external_skill_details;
DROP TABLE IF EXISTS email_skill_details;

CREATE INDEX IF NOT EXISTS idx_agent_skills_target
  ON agent_skills (workspace_id, target_type, target_id);

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_config_target_check;

ALTER TABLE agent_skills
  ADD CONSTRAINT agent_skills_config_target_check CHECK (
    jsonb_typeof(config) = 'object'
    AND (target_type IS NULL OR NULLIF(BTRIM(target_type), '') IS NOT NULL)
    AND (target_id IS NULL OR NULLIF(BTRIM(target_id), '') IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION agent_skill_target_uuid(value TEXT, target_name TEXT)
RETURNS UUID AS $$
BEGIN
  RETURN value::UUID;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'agent skill target % is not a valid UUID: %', target_name, value
    USING ERRCODE = '23503';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_agent_skill_target_reference()
RETURNS TRIGGER AS $$
DECLARE
  target_uuid UUID;
  target_exists BOOLEAN;
BEGIN
  IF NEW.kind = 'external_mcp' THEN
    IF NEW.target_type IS DISTINCT FROM 'mcp_connection' OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'external_mcp skill % must target an MCP connection', NEW.id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_external_mcp_target_fk';
    END IF;
    target_uuid := agent_skill_target_uuid(NEW.target_id, 'mcp_connection');
    SELECT TRUE INTO target_exists
    FROM mcp_connections
    WHERE id = target_uuid
      AND agent_id = NEW.agent_id
    FOR KEY SHARE;
    IF target_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'external_mcp skill % references unknown MCP connection %', NEW.id, NEW.target_id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_external_mcp_target_fk';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'customer_email' THEN
    IF NEW.target_type IS DISTINCT FROM 'customer_email_connection' OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'customer_email skill % must target a customer email connection', NEW.id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_customer_email_target_fk';
    END IF;
    target_uuid := agent_skill_target_uuid(NEW.target_id, 'customer_email_connection');
    SELECT TRUE INTO target_exists
    FROM customer_email_connections
    WHERE id = target_uuid
      AND workspace_id = NEW.workspace_id
    FOR KEY SHARE;
    IF target_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'customer_email skill % references unknown customer email connection %', NEW.id, NEW.target_id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_customer_email_target_fk';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'webhook' THEN
    IF NEW.target_type IS DISTINCT FROM 'webhook_destination' OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'webhook skill % must target a webhook destination', NEW.id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_webhook_target_fk';
    END IF;
    target_uuid := agent_skill_target_uuid(NEW.target_id, 'webhook_destination');
    SELECT TRUE INTO target_exists
    FROM workspace_webhook_destinations
    WHERE id = target_uuid
      AND workspace_id = NEW.workspace_id
    FOR KEY SHARE;
    IF target_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'webhook skill % references unknown webhook destination %', NEW.id, NEW.target_id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_webhook_target_fk';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_skills_target_reference
  ON agent_skills;

CREATE TRIGGER trg_agent_skills_target_reference
BEFORE INSERT OR UPDATE OF kind, agent_id, workspace_id, target_type, target_id
ON agent_skills
FOR EACH ROW
EXECUTE FUNCTION enforce_agent_skill_target_reference();

CREATE OR REPLACE FUNCTION block_agent_skill_mcp_connection_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agents WHERE id = OLD.agent_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_skills
    WHERE kind = 'external_mcp'
      AND agent_id = OLD.agent_id
      AND target_type = 'mcp_connection'
      AND target_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'MCP connection % is referenced by agent skills', OLD.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'agent_skills_external_mcp_target_fk';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass(format('%I.mcp_connections', current_schema())) IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_mcp_connections_block_agent_skill_reference
      ON mcp_connections;

    CREATE TRIGGER trg_mcp_connections_block_agent_skill_reference
    BEFORE DELETE
    ON mcp_connections
    FOR EACH ROW
    EXECUTE FUNCTION block_agent_skill_mcp_connection_delete();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION block_agent_skill_customer_email_connection_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_skills
    WHERE kind = 'customer_email'
      AND workspace_id = OLD.workspace_id
      AND target_type = 'customer_email_connection'
      AND target_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'customer email connection % is referenced by agent skills', OLD.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'agent_skills_customer_email_target_fk';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass(format('%I.customer_email_connections', current_schema())) IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_customer_email_connections_block_agent_skill_reference
      ON customer_email_connections;

    CREATE TRIGGER trg_customer_email_connections_block_agent_skill_reference
    BEFORE DELETE
    ON customer_email_connections
    FOR EACH ROW
    EXECUTE FUNCTION block_agent_skill_customer_email_connection_delete();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION block_agent_skill_webhook_destination_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_skills
    WHERE kind = 'webhook'
      AND workspace_id = OLD.workspace_id
      AND target_type = 'webhook_destination'
      AND target_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'webhook destination % is referenced by agent skills', OLD.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'agent_skills_webhook_target_fk';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass(format('%I.workspace_webhook_destinations', current_schema())) IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_workspace_webhook_destinations_block_agent_skill_reference
      ON workspace_webhook_destinations;

    CREATE TRIGGER trg_workspace_webhook_destinations_block_agent_skill_reference
    BEFORE DELETE
    ON workspace_webhook_destinations
    FOR EACH ROW
    EXECUTE FUNCTION block_agent_skill_webhook_destination_delete();
  END IF;
END $$;
