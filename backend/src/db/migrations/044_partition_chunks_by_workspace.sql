DO $$
DECLARE
  partition_count CONSTANT INTEGER := 16;
  partition_remainder INTEGER;
  chunks_is_partitioned BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_partitioned_table pt
    JOIN pg_class c ON c.oid = pt.partrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'chunks'
  )
  INTO chunks_is_partitioned;

  IF chunks_is_partitioned THEN
    RAISE NOTICE 'chunks already partitioned by workspace_id';
    RETURN;
  END IF;

  LOCK TABLE chunks IN ACCESS EXCLUSIVE MODE;

  ALTER TABLE chunks RENAME TO chunks_unpartitioned;
  ALTER TABLE chunks_unpartitioned RENAME CONSTRAINT chunks_pkey TO chunks_unpartitioned_pkey;
  ALTER INDEX IF EXISTS idx_chunks_workspace_id RENAME TO idx_chunks_workspace_id_unpartitioned;
  ALTER INDEX IF EXISTS idx_chunks_metadata RENAME TO idx_chunks_metadata_unpartitioned;
  ALTER INDEX IF EXISTS chunks_search_text_fts_idx RENAME TO chunks_search_text_fts_idx_unpartitioned;
  ALTER INDEX IF EXISTS chunks_embedding_hnsw_idx RENAME TO chunks_embedding_hnsw_idx_unpartitioned;

  CREATE TABLE chunks (
    id UUID NOT NULL,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER,
    search_text TEXT,
    embedding VECTOR(1536),
    start_offset INTEGER,
    end_offset INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, document_id, chunk_index)
  ) PARTITION BY HASH (workspace_id);

  FOR partition_remainder IN 0..partition_count - 1 LOOP
    EXECUTE format(
      'CREATE TABLE chunks_p%s PARTITION OF chunks FOR VALUES WITH (modulus %s, remainder %s)',
      partition_remainder,
      partition_count,
      partition_remainder
    );
  END LOOP;

  INSERT INTO chunks (
    id,
    document_id,
    workspace_id,
    chunk_index,
    content,
    token_count,
    search_text,
    embedding,
    start_offset,
    end_offset,
    created_at,
    metadata
  )
  SELECT id,
         document_id,
         workspace_id,
         chunk_index,
         content,
         token_count,
         search_text,
         embedding,
         start_offset,
         end_offset,
         created_at,
         metadata
  FROM chunks_unpartitioned;

  DROP TABLE chunks_unpartitioned;

  CREATE INDEX idx_chunks_workspace_id ON chunks (workspace_id);
  CREATE INDEX idx_chunks_document_id ON chunks (document_id);
  CREATE INDEX idx_chunks_metadata ON chunks USING GIN (metadata);
  CREATE INDEX chunks_search_text_fts_idx
    ON chunks
    USING GIN (to_tsvector('simple', coalesce(search_text, '')));
  CREATE INDEX chunks_embedding_hnsw_idx
    ON chunks
    USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;
END $$;
