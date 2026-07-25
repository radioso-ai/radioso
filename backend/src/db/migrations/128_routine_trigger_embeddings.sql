ALTER TABLE routine_definition
  ADD COLUMN IF NOT EXISTS trigger_embedding VECTOR(1536),
  ADD COLUMN IF NOT EXISTS trigger_embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS trigger_embedding_hash TEXT;

-- No HNSW index — per-agent routine cardinality is hundreds at most, a scan behind the existing agent index is fine.
