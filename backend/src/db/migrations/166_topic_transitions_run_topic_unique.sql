-- A census run records one identity classification per topic. Historical duplicate
-- rows came from repeated dissolution writes. A later non-dissolved row is a
-- correction, so it wins over any dissolved row; among rows with equal status, keep
-- the earliest by (created_at, id).
--
-- The migration runner wraps this whole file in a transaction and deliberately
-- disables its body timeouts, so CREATE INDEX CONCURRENTLY is unavailable here.
-- Restore bounded timeouts, then take a SHARE ROW EXCLUSIVE lock before cleanup. It
-- excludes both live writers and a second copy of this migration across the DELETE
-- and transactional index build while allowing readers through. Any timeout or build
-- failure rolls the transaction back, so this path cannot leave an invalid index.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '25s';

LOCK TABLE topic_transitions IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY run_id, topic_id
      ORDER BY
        CASE WHEN kind = 'dissolved' THEN 1 ELSE 0 END,
        created_at,
        id
    ) AS duplicate_rank
  FROM topic_transitions
)
DELETE FROM topic_transitions AS duplicate
USING ranked
WHERE duplicate.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX idx_topic_transitions_run_topic_unique
  ON topic_transitions (run_id, topic_id);
