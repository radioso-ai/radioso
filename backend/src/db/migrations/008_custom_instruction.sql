ALTER TABLE retrieval_settings
ADD COLUMN IF NOT EXISTS custom_instruction TEXT NOT NULL DEFAULT '';
