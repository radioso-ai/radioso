CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The inventory reader scopes every query to a workspace, then can combine this
-- trigram bitmap with workspace/status/source/metadata indexes for title contains.
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm
  ON documents USING gin (title gin_trgm_ops);
