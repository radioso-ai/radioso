-- Customer-facing indexed storage accounting.
-- Persisted byte size of the active indexed representation of a document.
-- Computed at write time so usage queries do not depend on OCTET_LENGTH scans.
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS content_size_bytes BIGINT;

ALTER TABLE documents
  DROP CONSTRAINT IF EXISTS documents_content_size_bytes_check;

ALTER TABLE documents
  ADD CONSTRAINT documents_content_size_bytes_check
  CHECK (content_size_bytes IS NULL OR content_size_bytes >= 0) NOT VALID;

-- Backfill in small batches: prefer the stored source size for uploaded files,
-- otherwise fall back to the UTF-8 byte length of inline source content. The
-- loop keeps row locks bounded on large installations.
DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ctid
      FROM documents
      WHERE content_size_bytes IS NULL
      LIMIT 5000
    )
    UPDATE documents d
    SET content_size_bytes = COALESCE(d.source_size_bytes, OCTET_LENGTH(d.source_content))
    FROM batch
    WHERE d.ctid = batch.ctid;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0;
  END LOOP;
END $$;

ALTER TABLE documents
  VALIDATE CONSTRAINT documents_content_size_bytes_check;

CREATE INDEX IF NOT EXISTS idx_documents_workspace_content_size_bytes
  ON documents (workspace_id)
  WHERE content_size_bytes IS NOT NULL;
