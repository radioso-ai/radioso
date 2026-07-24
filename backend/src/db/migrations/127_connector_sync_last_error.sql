ALTER TABLE connector_sync_state
  ADD COLUMN IF NOT EXISTS last_error TEXT;
