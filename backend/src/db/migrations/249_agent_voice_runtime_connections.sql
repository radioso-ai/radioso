-- The vendor agent Radioso created and maintains for an agent's voice channel, and the REST
-- credential that vendor agent sends on every turn. One per agent.
--
-- System owned: the operator's `voice` block (agents.behavior_settings.voice) names the runtime
-- binding, and a write of that block (a dashboard save, a Ray proposal, a bundle import) replaces
-- it whole. This row is what lets Radioso tell a vendor agent it created from one the operator
-- bound by hand, and repair, rotate or delete only its own. It never holds a vendor key, a secret
-- or a vendor URL: the vendor agent's id, the data residency region of the vendor account it lives
-- in, the credential's grant id, and the token prefix of the secret Radioso handed the vendor (the
-- part the API card shows). A rotation keeps the grant id and swaps the secret, so the prefix is
-- what tells the next Connect that the vendor's copy no longer works.
--
-- The connection goes with its agent and its workspace. A credential deleted out from under it
-- leaves the id NULL, and the next Connect issues a new one.
CREATE TABLE agent_voice_runtime_connections (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  vendor TEXT NOT NULL CHECK (length(vendor) BETWEEN 1 AND 32),
  region TEXT NOT NULL CHECK (length(region) BETWEEN 1 AND 16),
  vendor_agent_id TEXT NOT NULL CHECK (length(vendor_agent_id) BETWEEN 1 AND 128),
  channel_credential_id UUID REFERENCES agent_access_grants(id) ON DELETE SET NULL,
  channel_credential_fingerprint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_voice_runtime_connections_fingerprint_length_check
    CHECK (length(channel_credential_fingerprint) BETWEEN 1 AND 64),
  CONSTRAINT agent_voice_runtime_connections_credential_fingerprint_check
    CHECK (channel_credential_id IS NULL OR channel_credential_fingerprint IS NOT NULL)
);

-- The SET NULL above looks the connection up by its credential when a grant row is deleted.
CREATE INDEX agent_voice_runtime_connections_credential_idx
  ON agent_voice_runtime_connections (channel_credential_id)
  WHERE channel_credential_id IS NOT NULL;
