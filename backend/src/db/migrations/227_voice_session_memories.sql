-- What a voice session remembers between its requests (#1508), shared by every instance that serves
-- them. A voice runtime's requests carry no cookie affinity, so one session's requests land on
-- whichever backend instance the load balancer picks; their arrival order, the session's last bridge
-- line and its last exchange live here. Notifications on `radioso_voice_sessions` only wake the
-- instance running an overtaken request; these rows are the truth.

-- Arrival numbers, drawn while the session's row is locked: a session's numbers rise in arrival
-- order, and a session whose row was deleted never reuses one.
CREATE SEQUENCE voice_session_arrival_seq;

-- One row per voice session heard from recently. A row idle for longer than the session's memory
-- lasts (the replay window), with no request in flight, is deleted; a deleted conversation takes
-- the row with it.
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
  -- The last bridge line spoken in the session: whose request spoke it, when, and whether that
  -- request lost its caller before its outcome (null until the request ends).
  last_bridge_sequence BIGINT,
  last_bridge_at TIMESTAMPTZ,
  last_bridge_cut_off BOOLEAN,
  -- The newest exchange whose user message the conversation keeps: the stored reply and what was
  -- spoken of it, with the caller's utterance only as a digest. `last_exchange_note` is where the
  -- note of the reply's interruption stands, so it is recorded once.
  last_exchange_sequence BIGINT,
  last_exchange_conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  last_exchange JSONB,
  last_exchange_note TEXT NOT NULL DEFAULT 'none' CHECK (last_exchange_note IN ('none', 'pending', 'recorded')),
  CONSTRAINT voice_session_memories_session_uniq UNIQUE (agent_id, vendor, session_key)
);

CREATE INDEX voice_session_memories_touched_at_idx ON voice_session_memories (touched_at);
CREATE INDEX voice_session_memories_last_exchange_conversation_id_idx
  ON voice_session_memories (last_exchange_conversation_id);

-- One row per request of a session, from its arrival; `settled_at` is set when its turn ends. Rows
-- older than five minutes are deleted, so a request whose instance crashed stops counting as in
-- flight.
CREATE TABLE voice_session_requests (
  sequence BIGINT PRIMARY KEY,
  memory_id UUID NOT NULL REFERENCES voice_session_memories(id) ON DELETE CASCADE,
  arrived_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ
);

CREATE INDEX voice_session_requests_memory_id_sequence_idx ON voice_session_requests (memory_id, sequence);
CREATE INDEX voice_session_requests_arrived_at_idx ON voice_session_requests (arrived_at);
