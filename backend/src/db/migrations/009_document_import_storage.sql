ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'inline_text',
  ADD COLUMN IF NOT EXISTS source_filename TEXT,
  ADD COLUMN IF NOT EXISTS source_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_bucket TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_object TEXT,
  ADD COLUMN IF NOT EXISTS source_storage_generation TEXT,
  ADD COLUMN IF NOT EXISTS source_size_bytes INTEGER;
