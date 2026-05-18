-- Normalized-content hash for the active indexed representation of a document.
-- Enables skipping re-embedding when a recrawled page returns identical content
-- and powers per-page change detection beyond byte-size comparison alone.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_documents_workspace_source_external_id
  ON documents (workspace_id, source_id, external_document_id)
  WHERE external_document_id IS NOT NULL;
