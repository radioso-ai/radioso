-- Human-facing release numbers belong to immutable publications, not draft
-- generations. Existing releases receive a stable per-agent sequence.
ALTER TABLE agent_revisions
  ADD COLUMN published_version INTEGER;

WITH numbered_revisions AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY agent_id
      ORDER BY published_at ASC, id ASC
    ) AS published_version
  FROM agent_revisions
  WHERE published_at IS NOT NULL
)
UPDATE agent_revisions AS revision
SET published_version = numbered_revisions.published_version
FROM numbered_revisions
WHERE revision.id = numbered_revisions.id;

ALTER TABLE agent_revisions
  ADD CONSTRAINT agent_revisions_published_version_check
  CHECK ((published_at IS NULL AND published_version IS NULL)
    OR (published_at IS NOT NULL AND published_version IS NOT NULL AND published_version > 0));

CREATE UNIQUE INDEX agent_revisions_agent_published_version_key
  ON agent_revisions (agent_id, published_version)
  WHERE published_version IS NOT NULL;
