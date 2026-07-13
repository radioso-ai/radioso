-- Metadata extraction (enrichment) now runs as its own lower-priority job so a
-- document becomes queryable as soon as its chunks/embeddings are published.
-- The single Postgres job queue distinguishes the two phases with a `kind`
-- column; claim ordering (see documentProcessingJobRepository.claimNext) drains
-- vectorize jobs before enrich jobs.
ALTER TABLE document_processing_jobs
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'vectorize';

-- A vectorize job and its follow-up enrich job share the same
-- (document_id, document_revision), so the uniqueness that used to key a single
-- job per revision must now include the kind. This lets both phases coexist
-- while still preventing duplicate jobs of the same kind for a revision.
ALTER TABLE document_processing_jobs
  DROP CONSTRAINT IF EXISTS document_processing_jobs_document_id_document_revision_key;

ALTER TABLE document_processing_jobs
  ADD CONSTRAINT document_processing_jobs_document_id_document_revision_kind_key
  UNIQUE (document_id, document_revision, kind);

-- Support the claim ordering: queued jobs, available now, vectorize before
-- enrich, oldest first.
DROP INDEX IF EXISTS idx_document_processing_jobs_claim;
CREATE INDEX idx_document_processing_jobs_claim
  ON document_processing_jobs USING btree (status, available_at, kind, created_at);
