ALTER TABLE retrieval_settings
ADD COLUMN IF NOT EXISTS chunking_strategy TEXT NOT NULL DEFAULT 'fixed_window';
