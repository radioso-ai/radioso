ALTER TABLE connector_sync_state
  ADD COLUMN IF NOT EXISTS last_ingested_count INTEGER,
  ADD COLUMN IF NOT EXISTS sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_lock_token TEXT;
