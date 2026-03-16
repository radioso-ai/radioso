ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS document_processing_jobs (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  document_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, document_revision)
);

CREATE INDEX IF NOT EXISTS idx_document_processing_jobs_claim
  ON document_processing_jobs (status, available_at, created_at);
