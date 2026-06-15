-- Feature 089 refactor (cont.): re-home customer email skill definitions onto the
-- shared agent_skills spine (kind = 'customer_email') with typed email_skill_details.
-- These tables are branch-only; primary keys are PRESERVED on backfill so the existing
-- email_skill_activity.skill_definition_id references stay valid after the move.

CREATE TABLE IF NOT EXISTS email_skill_details (
  skill_id UUID PRIMARY KEY REFERENCES agent_skills(id) ON DELETE CASCADE,
  -- RESTRICT: a connection referenced by a skill cannot be deleted (clear error).
  connection_id UUID NOT NULL REFERENCES customer_email_connections(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (mode IN ('draft', 'send')),
  bound_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  exposed_inputs JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_email_skill_details_connection
  ON email_skill_details (connection_id);

-- The spine enforces UNIQUE (agent_id, skill_name) ACROSS kinds, so an agent that
-- already has an external MCP skill (backfilled by 099) sharing a name with a
-- customer email skill would otherwise abort this backfill with an opaque 23505.
-- Surface an actionable error naming the collision instead. This can only occur in
-- environments that ran an intermediate build which created email skills before
-- this migration; rename the conflicting skill, then re-deploy.
DO $$
DECLARE
  collision RECORD;
BEGIN
  SELECT e.agent_id, e.skill_name INTO collision
  FROM email_skill_definitions e
  JOIN agent_skills s ON s.agent_id = e.agent_id AND s.skill_name = e.skill_name
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot migrate email skill "%" for agent %: an agent skill with that name already exists on the shared agent_skills spine. Rename the conflicting skill before applying migration 100.',
      collision.skill_name, collision.agent_id;
  END IF;
END $$;

-- Backfill, preserving primary keys.
INSERT INTO agent_skills (id, agent_id, workspace_id, skill_name, kind, enabled, created_at, updated_at)
SELECT id, agent_id, workspace_id, skill_name, 'customer_email', enabled, created_at, updated_at
FROM email_skill_definitions;

INSERT INTO email_skill_details (skill_id, connection_id, mode, bound_inputs, exposed_inputs)
SELECT id, connection_id, mode, bound_inputs, exposed_inputs
FROM email_skill_definitions;

-- email_skill_activity.skill_definition_id referenced email_skill_definitions(id); those rows
-- now live in agent_skills with the same ids. Repoint the FK to the spine.
ALTER TABLE email_skill_activity
  DROP CONSTRAINT IF EXISTS email_skill_activity_skill_definition_id_fkey;
ALTER TABLE email_skill_activity
  ADD CONSTRAINT email_skill_activity_skill_definition_id_fkey
  FOREIGN KEY (skill_definition_id) REFERENCES agent_skills(id) ON DELETE CASCADE;

DROP TABLE email_skill_definitions;
