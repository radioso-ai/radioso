-- Feature 089 refactor: unify agent skill definitions onto a shared spine.
-- External MCP skills (087) and Customer Email skills (089) share one `agent_skills`
-- table (one @mention namespace per agent, enforced ACROSS kinds) with per-kind detail
-- tables that keep typed foreign keys and typed config.
--
-- This migration re-homes the SHIPPED external_skill_definitions table. Primary keys are
-- PRESERVED on backfill so every existing foreign key reference stays valid.
--
-- DEPLOY NOTE: this drops a shipped table in a single forward migration; it is not
-- expand/contract-safe for a rolling deploy (old pods reading external_skill_definitions
-- would error mid-rollout). Follows the repo's forward-only migration convention.

CREATE TABLE IF NOT EXISTS agent_skills (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('external_mcp', 'customer_email')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The skill name is the routine @mention identifier; unique within an agent across kinds.
  UNIQUE (agent_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_agent ON agent_skills (agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_skills_workspace ON agent_skills (workspace_id);

CREATE TABLE IF NOT EXISTS external_skill_details (
  skill_id UUID PRIMARY KEY REFERENCES agent_skills(id) ON DELETE CASCADE,
  -- RESTRICT: a connection referenced by a skill cannot be deleted (clear error).
  connection_id UUID NOT NULL REFERENCES mcp_connections(id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL,
  bound_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  exposed_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  declared_outcomes TEXT[],
  outcome_map JSONB
);

CREATE INDEX IF NOT EXISTS idx_external_skill_details_connection
  ON external_skill_details (connection_id);

-- Backfill the shipped external skill definitions, preserving primary keys.
INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, enabled, created_at, updated_at)
SELECT esd.id, esd.agent_id, a.workspace_id, esd.skill_name, 'external_mcp', esd.enabled, esd.created_at, esd.updated_at
FROM external_skill_definitions esd
JOIN agents a ON a.id = esd.agent_id;

INSERT INTO external_skill_details
  (skill_id, connection_id, tool_name, bound_params, exposed_params, declared_outcomes, outcome_map)
SELECT esd.id, esd.connection_id, esd.tool_name, esd.bound_params, esd.exposed_params, esd.declared_outcomes, esd.outcome_map
FROM external_skill_definitions esd;

DROP TABLE external_skill_definitions;
