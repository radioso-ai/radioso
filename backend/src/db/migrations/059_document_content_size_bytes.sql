-- Customer-facing indexed storage accounting.
-- Persisted byte size of the active indexed representation of a document.
-- Computed at write time so usage queries do not depend on OCTET_LENGTH scans.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS content_size_bytes BIGINT;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_content_size_bytes_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_content_size_bytes_check
  CHECK (content_size_bytes IS NULL OR content_size_bytes >= 0);

-- Backfill: prefer the stored source size for uploaded files, otherwise fall back
-- to the UTF-8 byte length of the inline source content. Only touch rows that have
-- not been set yet so re-runs are idempotent.
UPDATE documents
SET content_size_bytes = COALESCE(source_size_bytes, OCTET_LENGTH(source_content))
WHERE content_size_bytes IS NULL;

CREATE INDEX IF NOT EXISTS idx_documents_workspace_content_size_bytes
  ON documents (workspace_id)
  WHERE content_size_bytes IS NOT NULL;
