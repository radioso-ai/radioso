-- `chunks` is a hot partitioned table and API migrations run while the preceding
-- application revision still serves requests. These metadata-only catalog changes need ACCESS
-- EXCLUSIVE briefly, so fail the deploy instead of queueing traffic behind a long
-- reader or writer.
SET LOCAL lock_timeout = '3s';

-- Dropping the partitioned parent removes the attached HNSW indexes on every
-- partition before their `embedding` column disappears.
DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;

ALTER TABLE chunks
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_unbounded;
