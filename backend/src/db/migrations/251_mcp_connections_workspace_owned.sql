-- An MCP connection belongs to the workspace, so a server connected once serves every agent's
-- skills. Skills stay per-agent; a skill can bind any connection in its own workspace, and deleting
-- an agent leaves the connections its skills used.
--
-- agent_id is not dropped here. Migrations run at API boot while the previous revision still
-- serves, and that revision reads and writes connections by agent_id. A trigger gives its inserts a
-- workspace, so a connection it creates during the rollout is not lost to this revision. A later
-- release drops the column, its index and the trigger once no running revision names them.
--
-- The reverse does not hold. The previous revision finds connections by agent_id, so a connection
-- this revision creates, or a skill bound to another agent's connection, is unavailable to it during
-- the rollout and after an image rollback, until this revision serves again.
--
-- Locks. The whole file is one transaction, so every lock is held until it commits.
-- mcp_connections holds few rows and is touched only when a skill runs or is authored, so it goes
-- first. The new foreign key takes SHARE ROW EXCLUSIVE on workspaces, which leaves reads running.
-- Dropping the old foreign key takes ACCESS EXCLUSIVE on agents, which nearly every request reads,
-- so it runs last. The wait for each lock is bounded to three seconds; a deploy that hits it rolls
-- back and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE mcp_connections
  ADD COLUMN workspace_id UUID;

UPDATE mcp_connections AS connection
SET workspace_id = agent.workspace_id
FROM agents AS agent
WHERE agent.id = connection.agent_id;

ALTER TABLE mcp_connections
  ALTER COLUMN workspace_id SET NOT NULL,
  ALTER COLUMN agent_id DROP NOT NULL;

CREATE INDEX idx_mcp_connections_workspace ON mcp_connections (workspace_id);

COMMENT ON COLUMN mcp_connections.agent_id IS
  'Unused: connections belong to workspace_id. Dropped once no running revision names it.';

CREATE FUNCTION fill_mcp_connection_workspace_from_agent() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.workspace_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT workspace_id INTO NEW.workspace_id FROM agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_mcp_connections_fill_workspace_from_agent
  BEFORE INSERT ON mcp_connections
  FOR EACH ROW EXECUTE FUNCTION fill_mcp_connection_workspace_from_agent();

-- A skill on any agent may hold the connection, so the delete guard looks across the workspace.
-- A missing workspace means this delete is that workspace's cascade, which removes the skills too.
CREATE OR REPLACE FUNCTION block_agent_skill_mcp_connection_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_skills
    WHERE kind = 'external_mcp'
      AND workspace_id = OLD.workspace_id
      AND target_type = 'mcp_connection'
      AND target_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'MCP connection % is referenced by agent skills', OLD.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'agent_skills_external_mcp_target_fk';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_agent_skill_target_reference() RETURNS trigger
LANGUAGE plpgsql
AS $$
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
      AND workspace_id = NEW.workspace_id
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
$$;

ALTER TABLE mcp_connections
  ADD CONSTRAINT mcp_connections_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;

ALTER TABLE mcp_connections
  DROP CONSTRAINT mcp_connections_agent_id_fkey;
