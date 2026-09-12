-- A routine is an ordinary scoped area of an agent: whether it may activate is a plain flag,
-- mirroring agent_skills.enabled, and the agent revision system is the only publication
-- boundary. `status`, `version` and `lineage_id` stay as historical columns — the application
-- stops writing status transitions and stops branching lineages, so existing draft, published,
-- superseded and archived rows remain readable exactly as they are.
ALTER TABLE routine_definition
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- The canonical row of a lineage is its highest version (idx_routine_definition_lineage_version
-- makes that total and stable) and is the row the API now addresses. A lineage whose canonical
-- row is anything other than published was out of service — archived, or a draft revision an
-- operator started editing pre-cutover and never finished publishing — so it comes across as
-- disabled; every other row keeps the enabled default, including the superseded history a
-- pinned conversation may still resume.
UPDATE routine_definition AS d
SET enabled = FALSE
WHERE d.status != 'published'
  AND d.version = (
    SELECT MAX(v.version) FROM routine_definition v WHERE v.lineage_id = d.lineage_id
  );
