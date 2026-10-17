-- Where a session's recording lives at its vendor. A session Radioso started records the vendor
-- agent it opened on and the data residency region of that vendor account (`vendor_agent_id`,
-- `vendor_region`), and the page that opened it reports the vendor's own conversation id once the
-- vendor's client is connected (`vendor_conversation_id`), which Radioso stores only after the
-- vendor confirms the conversation belongs to that vendor agent. Together they name the recording
-- for a lookup with the workspace's own vendor key; a session a page started without Radioso has
-- none of them, and offers no recording. The id is unique per vendor and region, so one vendor
-- conversation never belongs to two sessions.
--
-- A row that names a recording must outlive its agent and its conversation: the row is the only
-- record of where the recording is, which a later deletion of the workspace needs, and a path that
-- deletes a conversation without first erasing what the vendor holds must not take it along. So
-- both links become SET NULL. A session whose conversation is gone is unbound: its next turn starts
-- a new conversation and binds it, as the cascade's deletion of the row did. The unique key on
-- (agent_id, vendor, session_key) stays: an agent-less row matches no turn, and NULLs never
-- collide. An unbound row may now be neither bound nor a start (a page's own session whose
-- conversation was deleted), so the CHECK that every row is one or the other goes; the next start
-- clears such rows out unless they name a recording.
--
-- Locks. Re-pointing the two foreign keys takes SHARE ROW EXCLUSIVE on agents and conversations and
-- ACCESS EXCLUSIVE on voice_sessions, and validates the keys by reading voice_sessions, a small
-- table, while holding them. The wait for any of them is bounded to three seconds; a migration that
-- cannot get them rolls back whole and is safe to run again.
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
  DROP CONSTRAINT voice_sessions_bound_or_started,
  ALTER COLUMN agent_id DROP NOT NULL,
  DROP CONSTRAINT voice_sessions_agent_id_fkey,
  ADD CONSTRAINT voice_sessions_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  DROP CONSTRAINT voice_sessions_conversation_id_fkey,
  ADD CONSTRAINT voice_sessions_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX voice_sessions_vendor_conversation_uniq
  ON voice_sessions (vendor, vendor_region, vendor_conversation_id)
  WHERE vendor_conversation_id IS NOT NULL;
