-- Keep the existing embedding VECTOR(1536) column and HNSW index in place.
-- Altering that column rewrites existing chunk rows, and rebuilding an HNSW
-- index over existing chunks can exceed the Cloud Run startup probe window
-- because migrations run before the API starts listening.
--
-- Non-1536-dimensional embeddings are stored in this new nullable column.
-- Adding a nullable column is metadata-only on modern PostgreSQL and keeps
-- startup migrations bounded.
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding_unbounded VECTOR;
