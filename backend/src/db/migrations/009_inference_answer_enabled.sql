ALTER TABLE retrieval_settings
ADD COLUMN IF NOT EXISTS inference_answer_enabled BOOLEAN NOT NULL DEFAULT FALSE;
