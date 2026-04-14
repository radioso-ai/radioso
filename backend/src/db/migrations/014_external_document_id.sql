ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS external_document_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_external_document_id_unique
  ON documents (workspace_id, external_document_id)
  WHERE external_document_id IS NOT NULL;
