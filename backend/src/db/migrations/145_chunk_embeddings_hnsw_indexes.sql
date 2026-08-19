-- Per-width HNSW indexes for chunk_embeddings.
--
-- chunk_embeddings.embedding is a typeless `vector` column so one table can hold
-- several embedding widths. A typeless column cannot carry an HNSW index, so each
-- width gets a partial expression index over a fixed-width cast. Without one, every
-- semantic search falls back to scanning all of a workspace's embeddings.
--
-- New widths are indexed by PgVectorAdapter.admin.prepareSpace, which runs before
-- the first row of that width is written. This migration exists for widths whose
-- rows were written before that behaviour existed — nothing on the read path calls
-- prepareSpace, so those would otherwise stay unindexed indefinitely.
--
-- The expression built here must stay identical to buildChunkEmbeddingIndexSql in
-- backend/src/modules/retrieval/infra/chunkEmbeddingVectorIndex.ts. An expression
-- index is only used when the query matches it textually, so drift silently
-- disables the index rather than failing. A unit test pins the two together.
--
-- Cost note: this builds indexes inline, and migrations run inside a transaction so
-- CREATE INDEX CONCURRENTLY is unavailable. On the widths this targets the table is
-- empty or near-empty, making the build effectively instant. A deployment that has
-- already accumulated a large chunk_embeddings should expect this to take longer and
-- to hold a write lock for the duration.

DO $$
DECLARE
  widths integer[];
  width integer;
BEGIN
  -- Collect the widths first. Iterating `FOR width IN SELECT ... FROM chunk_embeddings`
  -- holds a cursor open on the table, and CREATE INDEX then fails with "cannot CREATE
  -- INDEX because it is being used by active queries in this session".
  SELECT array_agg(DISTINCT dimensions ORDER BY dimensions)
    INTO widths
    FROM chunk_embeddings;

  FOREACH width IN ARRAY COALESCE(widths, ARRAY[]::integer[]) LOOP
    IF width <= 2000 THEN
      -- pgvector refuses an HNSW index on a `vector` wider than 2000 dimensions.
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw_%s_idx '
        'ON chunk_embeddings USING hnsw ((embedding::vector(%s)) vector_cosine_ops) '
        'WHERE dimensions = %s',
        width, width, width);
    ELSIF width <= 4000 THEN
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS chunk_embeddings_hnsw_%s_idx '
        'ON chunk_embeddings USING hnsw ((embedding::halfvec(%s)) halfvec_cosine_ops) '
        'WHERE dimensions = %s',
        width, width, width);
    END IF;
    -- halfvec carries its own HNSW ceiling of 4000 dimensions. Wider embeddings
    -- cannot be indexed at all, so they are left to exact search rather than
    -- issuing DDL that Postgres rejects.
  END LOOP;
END $$;
