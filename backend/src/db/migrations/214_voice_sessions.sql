-- One row per voice session: the vendor's opaque session key, scoped to the agent it called and to
-- the vendor namespace that issued it, mapped to the conversation its turns run in. A deleted
-- conversation takes its session with it, so the next turn of that session starts a new one.
CREATE TABLE voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL CHECK (length(vendor) BETWEEN 1 AND 64),
  session_key TEXT NOT NULL CHECK (length(session_key) BETWEEN 1 AND 256),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT voice_sessions_agent_vendor_session_key_uniq UNIQUE (agent_id, vendor, session_key)
);

CREATE INDEX voice_sessions_conversation_id_idx ON voice_sessions (conversation_id);
