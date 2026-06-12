ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS lineage_id UUID;

WITH lineage_groups AS (
  SELECT agent_id, name, gen_random_uuid() AS lineage_id
  FROM routine_definition
  WHERE lineage_id IS NULL
  GROUP BY agent_id, name
)
UPDATE routine_definition d
SET lineage_id = g.lineage_id
FROM lineage_groups g
WHERE d.lineage_id IS NULL
  AND d.agent_id = g.agent_id
  AND d.name = g.name;

WITH ranked_published AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY lineage_id
      ORDER BY version DESC, created_at DESC, id DESC
    ) AS published_rank
  FROM routine_definition
  WHERE status = 'published'
)
UPDATE routine_definition d
SET status = 'superseded',
    updated_at = NOW()
FROM ranked_published r
WHERE d.id = r.id
  AND r.published_rank > 1;

WITH ranked_drafts AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY agent_id, name
      ORDER BY created_at DESC, version DESC, id DESC
    ) AS draft_rank
  FROM routine_definition
  WHERE status = 'draft'
)
UPDATE routine_definition d
SET lineage_id = gen_random_uuid(),
    updated_at = NOW()
FROM ranked_drafts r
WHERE d.id = r.id
  AND r.draft_rank > 1;

ALTER TABLE routine_definition
  ALTER COLUMN lineage_id SET NOT NULL;

ALTER TABLE routine_definition
  DROP CONSTRAINT IF EXISTS routine_definition_status_check;

ALTER TABLE routine_definition
  ADD CONSTRAINT routine_definition_status_check
  CHECK (status IN ('draft', 'published', 'superseded', 'archived'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_definition_one_draft_per_lineage
  ON routine_definition (lineage_id)
  WHERE status = 'draft';

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_definition_one_published_per_lineage
  ON routine_definition (lineage_id)
  WHERE status = 'published';

CREATE UNIQUE INDEX IF NOT EXISTS idx_routine_definition_lineage_version
  ON routine_definition (lineage_id, version);

CREATE INDEX IF NOT EXISTS idx_routine_definition_agent_lineage
  ON routine_definition (agent_id, lineage_id);
