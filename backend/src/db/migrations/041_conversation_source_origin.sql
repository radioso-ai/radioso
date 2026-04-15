ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS source_origin TEXT;
