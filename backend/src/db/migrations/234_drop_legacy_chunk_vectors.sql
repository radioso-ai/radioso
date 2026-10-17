-- `chunks` is a hot partitioned table and API migrations run while the preceding
-- application revision still serves requests. Acquire the parent and all partition
-- locks together, then keep their whole acquisition inside a five-second deadline.
-- The runner resets both timeouts for each migration body, so these SET LOCAL values
-- deliberately restore the deployment bound after that reset.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5s';

LOCK TABLE chunks IN ACCESS EXCLUSIVE MODE;

-- Dropping the partitioned parent removes the attached HNSW indexes on every
-- partition before their `embedding` column disappears.
DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;

ALTER TABLE chunks
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_unbounded;
