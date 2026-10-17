-- Where a session's recording lives at its vendor. A session Radioso started records the vendor
-- agent it opened on and the data residency region of that vendor account (`vendor_agent_id`,
-- `vendor_region`), and the page that opened it reports the vendor's own conversation id once the
-- vendor's client is connected (`vendor_conversation_id`), which Radioso stores only after the
-- vendor confirms the conversation belongs to that vendor agent. Together they name the recording
-- for a lookup with the workspace's own vendor key; a session a page started without Radioso has
-- none of them, and offers no recording. The id is unique per vendor and region, so one vendor
-- conversation never belongs to two sessions.
--
-- A row that names a recording must outlive its agent: the conversation does (its agent link is
-- SET NULL), and the row is the only record of where the recording is, which a later deletion of the
-- conversation or the workspace needs. So the agent link becomes SET NULL too. The unique key on
-- (agent_id, vendor, session_key) stays: an agent-less row matches no turn, and NULLs never collide.
--
-- Locks. Re-pointing the foreign key takes SHARE ROW EXCLUSIVE on agents and ACCESS EXCLUSIVE on
-- voice_sessions, a small table; the key is added NOT VALID and validated in the same transaction,
-- and the wait for either lock is bounded to three seconds.
SET LOCAL lock_timeout = '3s';

ALTER TABLE voice_sessions
  ADD COLUMN vendor_agent_id TEXT
    CHECK (vendor_agent_id IS NULL OR length(vendor_agent_id) BETWEEN 1 AND 128),
  ADD COLUMN vendor_region TEXT
    CHECK (vendor_region IS NULL OR length(vendor_region) BETWEEN 1 AND 16),
  ADD COLUMN vendor_conversation_id TEXT
    CHECK (vendor_conversation_id IS NULL OR length(vendor_conversation_id) BETWEEN 1 AND 128),
  ADD CONSTRAINT voice_sessions_vendor_conversation_has_origin
    CHECK (vendor_conversation_id IS NULL OR (vendor_region IS NOT NULL AND vendor_agent_id IS NOT NULL)),
  ALTER COLUMN agent_id DROP NOT NULL,
  DROP CONSTRAINT voice_sessions_agent_id_fkey,
  ADD CONSTRAINT voice_sessions_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE voice_sessions VALIDATE CONSTRAINT voice_sessions_agent_id_fkey;

CREATE UNIQUE INDEX voice_sessions_vendor_conversation_uniq
  ON voice_sessions (vendor, vendor_region, vendor_conversation_id)
  WHERE vendor_conversation_id IS NOT NULL;
