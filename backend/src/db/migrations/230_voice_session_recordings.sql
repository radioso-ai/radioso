-- Where a session's recording lives at its vendor. A session Radioso started records the data
-- residency region of the vendor account it opened on (`vendor_region`), and the page that opened
-- it reports the vendor's own conversation id once the vendor's client is connected
-- (`vendor_conversation_id`). Both together name the recording for a lookup with the workspace's own
-- vendor key; a session a page started without Radioso has neither, and offers no recording. The
-- id is unique per vendor and region, so one vendor conversation never belongs to two sessions.
ALTER TABLE voice_sessions
  ADD COLUMN vendor_region TEXT
    CHECK (vendor_region IS NULL OR length(vendor_region) BETWEEN 1 AND 16),
  ADD COLUMN vendor_conversation_id TEXT
    CHECK (vendor_conversation_id IS NULL OR length(vendor_conversation_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT voice_sessions_vendor_conversation_has_region
    CHECK (vendor_conversation_id IS NULL OR vendor_region IS NOT NULL);

CREATE UNIQUE INDEX voice_sessions_vendor_conversation_uniq
  ON voice_sessions (vendor, vendor_region, vendor_conversation_id)
  WHERE vendor_conversation_id IS NOT NULL;
