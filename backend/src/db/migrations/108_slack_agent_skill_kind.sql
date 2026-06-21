-- Spec 092 Phase 2: routine-authored Slack posts use the shared agent_skills spine.
-- schema.sql is regenerated separately; do not hand-edit it here.

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_kind_check;

ALTER TABLE agent_skills
  ADD CONSTRAINT agent_skills_kind_check
  CHECK (kind IN ('external_mcp', 'customer_email', 'webhook', 'slack'));

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
    FROM integration_connections
    WHERE id = target_uuid
      AND workspace_id = NEW.workspace_id
      AND provider IN ('customer_email_google', 'customer_email_microsoft')
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

  IF NEW.kind = 'slack' THEN
    IF NEW.target_type IS DISTINCT FROM 'slack_installation' OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'slack skill % must target a Slack installation', NEW.id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_slack_target_fk';
    END IF;
    target_uuid := agent_skill_target_uuid(NEW.target_id, 'slack_installation');
    SELECT TRUE INTO target_exists
    FROM slack_installations
    WHERE id = target_uuid
      AND workspace_id = NEW.workspace_id
    FOR KEY SHARE;
    IF target_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'slack skill % references unknown Slack installation %', NEW.id, NEW.target_id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_slack_target_fk';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
