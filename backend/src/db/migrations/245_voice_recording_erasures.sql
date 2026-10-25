-- The voice recordings a deletion leaves for the vendor to delete, and the key to delete them with.
--
-- A conversation, visitor, workspace or organization deletion writes these rows in its own
-- transaction, straight from voice_sessions (INSERT ... SELECT, so a workspace with any number of
-- recordings fits one statement), so the deletion and its backlog commit together or not at all.
-- A background job then asks the vendor to delete each recording, with retries per recording. The
-- rows outlive what was deleted: they carry the organization, workspace and conversation as plain
-- ids, with no foreign key to anything a deletion removes.
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

-- The organization's list of recordings left at the vendor reads its erasures by organization.
CREATE INDEX voice_recording_erasures_account_idx ON voice_recording_erasures (account_id);

-- One row per recording. A recording the vendor deleted, or no longer held, goes with its audit
-- event. One it would not delete is asked again after a growing wait; once its asks run out it
-- stays as `failed`, with why and when, as the record that it is still at the vendor.
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
  -- When the recording may be asked about next. A claim moves it forward by the claim's lease, so
  -- a run that takes over a lost one cannot ask the vendor about a recording still being asked.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Why the recording is still at the vendor after the last ask: a closed code, never a vendor response.
  failure_reason TEXT CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 64),
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT voice_recording_erasure_items_failed_has_reason CHECK (status = 'pending' OR failure_reason IS NOT NULL),
  CONSTRAINT voice_recording_erasure_items_failed_has_time CHECK ((status = 'failed') = (failed_at IS NOT NULL))
);

-- An erasure's recordings, whatever their state: the cascade, and the counts after each run.
CREATE INDEX voice_recording_erasure_items_erasure_idx ON voice_recording_erasure_items (erasure_id);

-- The drain's claim: an erasure's pending recordings, those due first.
CREATE INDEX voice_recording_erasure_items_due_idx
  ON voice_recording_erasure_items (erasure_id, next_attempt_at)
  WHERE status = 'pending';

-- The recovery sweep: pending recordings overdue across every erasure.
CREATE INDEX voice_recording_erasure_items_overdue_idx
  ON voice_recording_erasure_items (next_attempt_at)
  WHERE status = 'pending';

-- A hand-off never holds a recording another pending row already holds.
CREATE INDEX voice_recording_erasure_items_pending_recording_idx
  ON voice_recording_erasure_items (vendor_conversation_id, vendor_region)
  WHERE status = 'pending';
