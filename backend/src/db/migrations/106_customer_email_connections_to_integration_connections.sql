-- Spec 092 Phase R: fold customer_email_connections into integration_connections.
-- This is a behavior-preserving persistence move; customer-email public API
-- provider ids remain mapped by application code.

INSERT INTO integration_connections (
  id,
  workspace_id,
  oauth_connection_id,
  provider,
  display_name,
  status,
  last_health_status,
  last_health_checked_at,
  last_error_code,
  config,
  created_at,
  updated_at
)
SELECT
  id,
  workspace_id,
  oauth_connection_id,
  CASE provider
    WHEN 'google_mail' THEN 'customer_email_google'
    WHEN 'microsoft_graph_mail' THEN 'customer_email_microsoft'
    ELSE provider
  END,
  display_name,
  status,
  last_health_status,
  last_health_checked_at,
  last_error_code,
  jsonb_build_object(
    'senderEmail', sender_email,
    'senderName', sender_name,
    'replyToEmail', reply_to_email
  ),
  created_at,
  updated_at
FROM customer_email_connections
ON CONFLICT (id) DO NOTHING;

ALTER TABLE email_skill_activity
  DROP CONSTRAINT IF EXISTS email_skill_activity_connection_id_fkey;

ALTER TABLE email_skill_activity
  ADD CONSTRAINT email_skill_activity_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE RESTRICT;

DROP TRIGGER IF EXISTS trg_customer_email_connections_block_agent_skill_reference
  ON customer_email_connections;

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
      AND (provider LIKE 'customer_email_%' OR provider LIKE '%\_mail' ESCAPE '\')
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

CREATE OR REPLACE FUNCTION block_agent_skill_customer_email_connection_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.provider NOT LIKE 'customer_email_%' AND OLD.provider NOT LIKE '%\_mail' ESCAPE '\' THEN
    RETURN OLD;
  END IF;

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

DROP TRIGGER IF EXISTS trg_integration_connections_block_customer_email_agent_skill_reference
  ON integration_connections;

CREATE TRIGGER trg_integration_connections_block_customer_email_agent_skill_reference
BEFORE DELETE
ON integration_connections
FOR EACH ROW
EXECUTE FUNCTION block_agent_skill_customer_email_connection_delete();

DROP TABLE customer_email_connections;
