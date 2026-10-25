-- The voice recordings a deletion leaves for the vendor to delete, and the key to delete them with.
--
-- A conversation, visitor, workspace or organization deletion writes these rows in its own
-- transaction, so the deletion and its backlog commit together or not at all, and a background
-- job then asks the vendor to delete each recording, with retries. The rows outlive what was
-- deleted: they carry the organization, workspace and conversation as plain ids, with no foreign
-- key to anything a deletion removes.
--
-- One erasure per workspace and vendor a deletion reached. It holds that workspace's vendor key,
-- sealed with the workspace credential store's own encryption (CONNECTOR_ENCRYPTION_KEY), because
-- a workspace's deletion takes its credential store with it. The key is NULL when the deletion
-- could read none, and is cleared as soon as no pending recording needs it. The erasure goes once
-- it has no recording left.
CREATE TABLE voice_recording_erasures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  vendor TEXT NOT NULL CHECK (length(vendor) BETWEEN 1 AND 32),
  sealed_api_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per recording. A recording the vendor deleted, or no longer held, goes with its audit
-- event. One it would not delete is asked again; once its asks run out it stays as `failed`, with
-- why, as the record that it is still at the vendor.
CREATE TABLE voice_recording_erasure_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  erasure_id UUID NOT NULL REFERENCES voice_recording_erasures(id) ON DELETE CASCADE,
  -- Null for a call whose first turn never came: the vendor still holds its recording.
  conversation_id UUID,
  vendor_region TEXT NOT NULL CHECK (length(vendor_region) BETWEEN 1 AND 16),
  vendor_conversation_id TEXT NOT NULL CHECK (length(vendor_conversation_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed')),
  -- Asks of the vendor so far, counted as each is claimed, so a crashed ask counts too.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Why the recording is still at the vendor after the last ask: a closed code, never a vendor response.
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT voice_recording_erasure_items_failed_has_reason CHECK (status = 'pending' OR failure_reason IS NOT NULL)
);

-- The drain's claim: an erasure's pending recordings, those asked least first.
CREATE INDEX voice_recording_erasure_items_pending_idx
  ON voice_recording_erasure_items (erasure_id, attempts, created_at)
  WHERE status = 'pending';

-- The recordings left at the vendor, newest first.
CREATE INDEX voice_recording_erasure_items_failed_idx
  ON voice_recording_erasure_items (updated_at)
  WHERE status = 'failed';
