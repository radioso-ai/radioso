-- Feature 087: External skills via MCP.
-- Per-agent MCP connections + named skill definitions (data, not code).

CREATE TABLE IF NOT EXISTS mcp_connections (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('access_token', 'oauth')),
  -- Encrypted via fieldEncryption (AES-256-GCM). Never store plaintext secrets.
  credential_ciphertext TEXT,
  encryption_key_id TEXT,
  oauth_client_ciphertext TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN ('unconfigured', 'authorized', 'needs_reauth', 'error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_connections_agent ON mcp_connections (agent_id);

CREATE TABLE IF NOT EXISTS external_skill_definitions (
  id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  -- RESTRICT: a connection referenced by a skill cannot be deleted (clear error),
  -- per the data model. Skill definitions are removed first.
  connection_id UUID NOT NULL REFERENCES mcp_connections(id) ON DELETE RESTRICT,
  skill_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  bound_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  exposed_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  declared_outcomes TEXT[],
  outcome_map JSONB,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The skill name is the routine @mention identifier; unique within an agent.
  UNIQUE (agent_id, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_external_skill_definitions_agent ON external_skill_definitions (agent_id);
CREATE INDEX IF NOT EXISTS idx_external_skill_definitions_connection ON external_skill_definitions (connection_id);
