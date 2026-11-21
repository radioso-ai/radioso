-- API connections (#1883): a workspace-owned REST API an agent's API request skills call. A
-- connection holds the base URL every request's path is appended to, how requests authenticate,
-- and non-secret default headers. A skill (agent_skills kind 'api_request') targets one
-- connection, the way an MCP tool skill targets an MCP connection.
--
-- Secrets. The credential (a bearer token, a header value, or a basic username:password) is
-- encrypted under CONNECTOR_ENCRYPTION_KEY and is never returned by the API; a connection without
-- auth has none. Default headers are plain text and may not carry credentials: the service refuses
-- authorization, cookie and the transport's own headers there.
--
-- Base URL. https, or plain http to this machine for local development, the same rule as webhook
-- destinations; the service also checks the host resolves to a public address when it is saved.
--
-- References. A skill's target is checked by enforce_agent_skill_target_reference, and a
-- connection a skill still targets cannot be deleted. Both raise 23503 with the constraint name
-- agent_skills_api_request_target_fk, which the services map to a 400 and a 409.
--
-- Locks. The whole file is one transaction, so every lock is held until it commits. The new
-- table's foreign key takes SHARE ROW EXCLUSIVE on workspaces, which leaves reads running. Swapping
-- agent_skills' kind check takes ACCESS EXCLUSIVE on agent_skills, which every chat turn reads, so
-- it runs last; the table is small and the check is a scan of it. The wait for each lock is bounded
-- to three seconds; a deploy that hits it rolls back and a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE api_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  base_url TEXT NOT NULL CHECK (
    base_url ~* '^https://'
    OR base_url ~* '^http://(([a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:[0-9]+)?(/|$)'
  ),
  auth_scheme TEXT NOT NULL DEFAULT 'none' CHECK (auth_scheme IN ('none', 'bearer', 'header', 'basic')),
  auth_header_name TEXT NULL,
  credential_ciphertext TEXT NULL,
  default_headers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(default_headers) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_connections_auth_check CHECK (
    (auth_scheme = 'none' AND credential_ciphertext IS NULL AND auth_header_name IS NULL)
    OR (auth_scheme IN ('bearer', 'basic') AND credential_ciphertext IS NOT NULL AND auth_header_name IS NULL)
    OR (auth_scheme = 'header' AND credential_ciphertext IS NOT NULL AND auth_header_name IS NOT NULL)
  )
);

-- One name per workspace, case-insensitively; it also serves every workspace-scoped lookup.
CREATE UNIQUE INDEX idx_api_connections_workspace_lower_name
  ON api_connections (workspace_id, lower(name));

-- A skill in any agent of the workspace may target the connection, so the guard looks across the
-- workspace. A missing workspace means this delete is that workspace's cascade, which removes the
-- skills too.
CREATE FUNCTION block_agent_skill_api_connection_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM agent_skills
    WHERE kind = 'api_request'
      AND workspace_id = OLD.workspace_id
      AND target_type = 'api_connection'
      AND target_id = OLD.id::text
  ) THEN
    RAISE EXCEPTION 'API connection % is referenced by agent skills', OLD.id
      USING ERRCODE = '23503',
            CONSTRAINT = 'agent_skills_api_request_target_fk';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_api_connections_block_agent_skill_reference
  BEFORE DELETE ON api_connections
  FOR EACH ROW EXECUTE FUNCTION block_agent_skill_api_connection_delete();

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

  IF NEW.kind = 'api_request' THEN
    IF NEW.target_type IS DISTINCT FROM 'api_connection' OR NEW.target_id IS NULL THEN
      RAISE EXCEPTION 'api_request skill % must target an API connection', NEW.id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_api_request_target_fk';
    END IF;
    target_uuid := agent_skill_target_uuid(NEW.target_id, 'api_connection');
    SELECT TRUE INTO target_exists
    FROM api_connections
    WHERE id = target_uuid
      AND workspace_id = NEW.workspace_id
    FOR KEY SHARE;
    IF target_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'api_request skill % references unknown API connection %', NEW.id, NEW.target_id
        USING ERRCODE = '23503',
              CONSTRAINT = 'agent_skills_api_request_target_fk';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;


ALTER TABLE agent_skills
  DROP CONSTRAINT agent_skills_kind_check;

ALTER TABLE agent_skills
  ADD CONSTRAINT agent_skills_kind_check
  CHECK (kind IN ('external_mcp', 'customer_email', 'webhook', 'slack', 'retrieve', 'notify', 'api_request'));
