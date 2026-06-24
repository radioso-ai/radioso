ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_context JSONB NULL;
