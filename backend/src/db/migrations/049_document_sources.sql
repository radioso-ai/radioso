CREATE TABLE IF NOT EXISTS document_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  external_id TEXT,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_status TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE documents
ADD COLUMN IF NOT EXISTS source_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'documents_source_id_fkey'
  ) THEN
    ALTER TABLE documents
    ADD CONSTRAINT documents_source_id_fkey
    FOREIGN KEY (source_id)
    REFERENCES document_sources(id)
    ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_sources_workspace_kind
  ON document_sources (workspace_id, kind);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_sources_workspace_kind_external_id_unique
  ON document_sources (workspace_id, kind, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_workspace_source
  ON documents (workspace_id, source_id);

DROP INDEX IF EXISTS idx_documents_workspace_external_document_id_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_external_document_id_unique
  ON documents (workspace_id, external_document_id)
  WHERE source_id IS NULL AND external_document_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_workspace_source_external_document_id_unique
  ON documents (workspace_id, source_id, external_document_id)
  WHERE source_id IS NOT NULL AND external_document_id IS NOT NULL;
