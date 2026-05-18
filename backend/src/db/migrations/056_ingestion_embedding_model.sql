ALTER TABLE ingestion_settings
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small';

ALTER TABLE ingestion_settings
  ADD COLUMN IF NOT EXISTS pending_embedding_model TEXT;

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small';
