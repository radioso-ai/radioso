-- Refuse deleting a webhook destination that an agent's published release still exports to (#1899).
--
-- A conversation runs the routines its agent's published release froze
-- (`agent_revisions.snapshot -> 'routines'`), and a completed routine delivers to that frozen
-- `completionExport.destinationRef`. Migration 182's delete guard read only the highest-version
-- live `routine_definition` row, which is the draft's. An operator who pointed an export elsewhere,
-- or switched it off, in the draft could delete the old destination while every completed routine on
-- the published release still delivered to it, and each one then skipped its delivery.
--
-- `routine_export_destination_uses` is the one answer to "which routines export to this
-- destination": the enabled routines in an agent's draft, and the enabled routines in the release
-- the agent publishes now. Releases that only older conversations are pinned to are not counted, as
-- for skill targets (migration 276). The backend reads the same function to name the agent and the
-- routine in the 409 it answers. Destination ids are UUIDs stored as text and compared without
-- regard to letter case.

CREATE OR REPLACE FUNCTION routine_export_destination_uses(p_workspace_id UUID, p_destination_id TEXT)
RETURNS TABLE (agent_id UUID, agent_name TEXT, routine_name TEXT, in_draft BOOLEAN, in_published_release BOOLEAN)
LANGUAGE sql
STABLE
AS $$
  SELECT
    agent.id,
    COALESCE(NULLIF(agent.internal_name, ''), agent.name),
    uses.routine_name,
    bool_or(uses.in_draft),
    bool_or(NOT uses.in_draft)
  FROM (
    SELECT d.agent_id, d.name AS routine_name, TRUE AS in_draft
    FROM routine_completion_export ce
    JOIN routine_definition d ON d.id = ce.definition_id
    JOIN agents draft_agent ON draft_agent.id = d.agent_id
    WHERE draft_agent.workspace_id = p_workspace_id
      AND d.enabled = TRUE
      AND d.version = (SELECT MAX(v.version) FROM routine_definition v WHERE v.lineage_id = d.lineage_id)
      AND ce.enabled = TRUE
      AND lower(ce.destination_ref) = lower(p_destination_id)
    UNION ALL
    SELECT published_agent.id, released_routine ->> 'name', FALSE
    FROM agents published_agent
    JOIN agent_revisions published_release ON published_release.id = published_agent.published_revision_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(published_release.snapshot -> 'routines') = 'array'
        THEN published_release.snapshot -> 'routines'
        ELSE '[]'::jsonb
      END
    ) AS released_routine
    WHERE published_agent.workspace_id = p_workspace_id
      AND COALESCE((released_routine ->> 'enabled')::boolean, TRUE)
      AND COALESCE((released_routine #>> '{completionExport,enabled}')::boolean, FALSE)
      AND lower(released_routine #>> '{completionExport,destinationRef}') = lower(p_destination_id)
  ) uses
  JOIN agents agent ON agent.id = uses.agent_id
  GROUP BY agent.id, agent.internal_name, agent.name, uses.routine_name
  ORDER BY 2, 3, 1;
$$;

CREATE OR REPLACE FUNCTION block_webhook_destination_delete_if_published_reference()
RETURNS TRIGGER AS $$
DECLARE
  use_list TEXT;
BEGIN
  -- Deleting the workspace removes its agents, routines and destinations together.
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;

  SELECT string_agg(
    format('%s on %s%s', uses.routine_name, uses.agent_name, CASE WHEN uses.in_draft THEN '' ELSE ' (published release)' END),
    ', '
  )
  INTO use_list
  FROM routine_export_destination_uses(OLD.workspace_id, OLD.id::text) uses;

  IF use_list IS NOT NULL THEN
    RAISE EXCEPTION 'webhook destination % is referenced by enabled routines: %', OLD.id, use_list
      USING ERRCODE = '23503',
            CONSTRAINT = 'workspace_webhook_destinations_published_routine_reference';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
