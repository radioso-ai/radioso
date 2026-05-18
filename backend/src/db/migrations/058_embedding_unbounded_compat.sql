ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding_unbounded VECTOR;
