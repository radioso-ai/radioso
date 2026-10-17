ALTER TABLE document_processing_jobs
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;
