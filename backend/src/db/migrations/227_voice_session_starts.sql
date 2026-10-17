-- A session Radioso starts for a page waits here for its first turn: the session key it minted,
-- the website embed's public session and visitor key that asked for it, and until when the first
-- turn may still claim them. The first turn binds its conversation onto the same row, so a bound
-- row is the plain session-to-conversation mapping it always was. A start whose first turn never
-- came is removed at the agent's next start.
ALTER TABLE voice_sessions
  ALTER COLUMN conversation_id DROP NOT NULL,
  ADD COLUMN started_public_session_id TEXT
    CHECK (started_public_session_id IS NULL OR length(started_public_session_id) BETWEEN 1 AND 256),
  ADD COLUMN started_visitor_key TEXT
    CHECK (started_visitor_key IS NULL OR length(started_visitor_key) BETWEEN 1 AND 256),
  ADD COLUMN start_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT voice_sessions_bound_or_started
    CHECK (conversation_id IS NOT NULL OR (started_public_session_id IS NOT NULL AND start_expires_at IS NOT NULL));
