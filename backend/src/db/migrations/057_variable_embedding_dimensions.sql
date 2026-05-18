DO $$
DECLARE
  embedding_type TEXT;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod)
  INTO embedding_type
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'chunks'
    AND a.attname = 'embedding'
    AND NOT a.attisdropped;

  IF embedding_type = 'vector(1536)' THEN
    DROP INDEX IF EXISTS chunks_embedding_1536_hnsw_idx;
    DROP INDEX IF EXISTS chunks_embedding_hnsw_idx;

    ALTER TABLE chunks
      ALTER COLUMN embedding TYPE VECTOR
      USING embedding::VECTOR;
  END IF;
END $$;

DROP INDEX IF EXISTS chunks_embedding_1536_hnsw_idx;

CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
ON chunks
USING hnsw ((embedding::vector(1536)) vector_cosine_ops)
WHERE embedding IS NOT NULL
  AND vector_dims(embedding) = 1536;
