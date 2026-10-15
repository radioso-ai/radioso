-- What a voice session remembers between its requests (#1508), for the instances that serve it.
-- A voice runtime's requests carry no cookie affinity, so one session's requests land on whichever
-- backend instance the load balancer picks. Each instance keeps its own requests' state in memory;
-- this row is how the others see it. Notifications on `radioso_voice_sessions` only wake the
-- instance running an overtaken request; the row is the truth.

-- Arrival numbers, drawn while the session's row is locked: a session's numbers rise in arrival
-- order, and a session whose row was deleted never reuses one.
CREATE SEQUENCE voice_session_arrival_seq;

-- One row per voice session heard from recently. Every write to a session locks its row, so
-- arrivals, bridge claims and settles of one session are ordered here. A row idle for longer than
-- the replay window with no request in flight is deleted, and a deleted conversation takes the row
-- with it.
CREATE TABLE voice_session_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL CHECK (length(vendor) BETWEEN 1 AND 64),
  session_key TEXT NOT NULL CHECK (length(session_key) BETWEEN 1 AND 256),
  -- The newest request's arrival number, and the one before it, which the newest overtook.
  newest_sequence BIGINT NOT NULL,
  previous_sequence BIGINT,
  touched_at TIMESTAMPTZ NOT NULL,
  -- The session's requests in flight, by arrival number: when each arrived (epoch ms), the instance
  -- running it, and, once a newer request overtook it, when and from which instance. A request
  -- leaves when it settles, or five minutes after it arrived when its instance never settled it.
  requests JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The last bridge line spoken in the session: whose request spoke it, when, and whether that
  -- request lost its caller before its outcome (null until the request settles).
  last_bridge_sequence BIGINT,
  last_bridge_at TIMESTAMPTZ,
  last_bridge_cut_off BOOLEAN,
  -- The newest exchange whose user message the conversation keeps: the stored reply and what was
  -- spoken of it, with the caller's utterance only as a digest.
  last_exchange_sequence BIGINT,
  last_exchange_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  last_exchange JSONB,
  -- Where the note of the reply's interruption stands, so it is recorded once. A `pending` claim
  -- names its owner, and another instance may take it over once it is older than a minute.
  last_exchange_note TEXT NOT NULL DEFAULT 'none' CHECK (last_exchange_note IN ('none', 'pending', 'recorded')),
  last_exchange_note_owner TEXT CHECK (length(last_exchange_note_owner) BETWEEN 1 AND 128),
  last_exchange_note_claimed_at TIMESTAMPTZ,
  CONSTRAINT voice_session_memories_session_uniq UNIQUE (agent_id, vendor, session_key)
);

CREATE INDEX voice_session_memories_touched_at_idx ON voice_session_memories (touched_at);
CREATE INDEX voice_session_memories_last_exchange_conversation_id_idx
  ON voice_session_memories (last_exchange_conversation_id);
