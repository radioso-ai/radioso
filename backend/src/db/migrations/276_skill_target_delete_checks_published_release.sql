-- Refuse deleting a skill target that an agent's published release still uses (#1886).
--
-- Conversations run the skill rows their agent's published release froze
-- (`agent_revisions.snapshot -> 'agentSkills'`), not the live `agent_skills` rows, which are the
-- draft's. The delete guards on API connections, MCP connections, webhook destinations and customer
-- email connections looked only at the live rows, so a target the draft had moved off could be
-- deleted while every new conversation still called it. Slack installations had no guard at all.
--
-- `agent_skill_target_uses` is the one answer to "which skills use this target": every skill on it in
-- an agent's draft, and every skill on it in the release the agent publishes now. Releases that only
-- older conversations are still pinned to are not counted: a conversation keeps its release for good,
-- so counting them would keep a target from ever being deleted. A release that recorded no
-- skills (one frozen before skills were tracked, or cleared by migration 268) serves the live table,
-- which the draft branch already covers. The backend reads the same function to name the skills in
-- the 409 it answers, and each kind's trigger raises the constraint name its service already maps.

CREATE OR REPLACE FUNCTION agent_skill_target_uses(p_workspace_id UUID, p_target_type TEXT, p_target_id TEXT)
RETURNS TABLE (agent_id UUID, agent_name TEXT, skill_name TEXT, in_draft BOOLEAN, in_published_release BOOLEAN)
LANGUAGE sql
STABLE
AS $$
  SELECT
    agent.id,
    COALESCE(NULLIF(agent.internal_name, ''), agent.name),
    uses.skill_name,
    bool_or(uses.in_draft),
    bool_or(NOT uses.in_draft)
  FROM (
    SELECT draft_skill.agent_id, draft_skill.skill_name, TRUE AS in_draft
    FROM agent_skills draft_skill
    WHERE draft_skill.workspace_id = p_workspace_id
      AND draft_skill.target_type = p_target_type
      AND draft_skill.target_id = p_target_id
    UNION ALL
    SELECT published_agent.id, released_skill ->> 'skillName', FALSE
    FROM agents published_agent
    JOIN agent_revisions published_release ON published_release.id = published_agent.published_revision_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(published_release.snapshot -> 'agentSkills') = 'array'
        THEN published_release.snapshot -> 'agentSkills'
        ELSE '[]'::jsonb
      END
    ) AS released_skill
    WHERE published_agent.workspace_id = p_workspace_id
      AND released_skill ->> 'targetType' = p_target_type
      AND released_skill ->> 'targetId' = p_target_id
  ) uses
  JOIN agents agent ON agent.id = uses.agent_id
  GROUP BY agent.id, agent.internal_name, agent.name, uses.skill_name
  ORDER BY 2, 3, 1;
$$;

-- Raises the kind's constraint when a skill uses the target. Deleting the workspace removes its
-- agents, skills and targets together, so a target whose workspace is already gone is let go.
CREATE OR REPLACE FUNCTION block_agent_skill_target_delete(
  p_workspace_id UUID,
  p_target_type TEXT,
  p_target_id UUID,
  p_target_label TEXT,
  p_constraint TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  use_list TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = p_workspace_id) THEN
    RETURN;
  END IF;

  SELECT string_agg(
    format('%s on %s%s', uses.skill_name, uses.agent_name, CASE WHEN uses.in_draft THEN '' ELSE ' (published release)' END),
    ', '
  )
  INTO use_list
  FROM agent_skill_target_uses(p_workspace_id, p_target_type, p_target_id::text) uses;

  IF use_list IS NOT NULL THEN
    RAISE EXCEPTION '% % is referenced by agent skills: %', p_target_label, p_target_id, use_list
      USING ERRCODE = '23503',
            CONSTRAINT = p_constraint;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION block_agent_skill_api_connection_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM block_agent_skill_target_delete(
    OLD.workspace_id, 'api_connection', OLD.id, 'API connection', 'agent_skills_api_request_target_fk'
  );
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION block_agent_skill_mcp_connection_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM block_agent_skill_target_delete(
    OLD.workspace_id, 'mcp_connection', OLD.id, 'MCP connection', 'agent_skills_external_mcp_target_fk'
  );
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION block_agent_skill_webhook_destination_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM block_agent_skill_target_delete(
    OLD.workspace_id, 'webhook_destination', OLD.id, 'webhook destination', 'agent_skills_webhook_target_fk'
  );
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION block_agent_skill_customer_email_connection_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provider NOT IN ('customer_email_google', 'customer_email_microsoft') THEN
    RETURN OLD;
  END IF;

  PERFORM block_agent_skill_target_delete(
    OLD.workspace_id, 'customer_email_connection', OLD.id, 'customer email connection', 'agent_skills_customer_email_target_fk'
  );
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION block_agent_skill_slack_installation_delete() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM block_agent_skill_target_delete(
    OLD.workspace_id, 'slack_installation', OLD.id, 'Slack installation', 'agent_skills_slack_target_fk'
  );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_slack_installations_block_agent_skill_reference ON slack_installations;
CREATE TRIGGER trg_slack_installations_block_agent_skill_reference
  BEFORE DELETE ON slack_installations
  FOR EACH ROW EXECUTE FUNCTION block_agent_skill_slack_installation_delete();
