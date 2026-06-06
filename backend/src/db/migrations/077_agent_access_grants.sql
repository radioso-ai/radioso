CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS agent_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('workspace-admin', 'agent-api', 'public-launch')),
  role TEXT NOT NULL DEFAULT 'public' CHECK (role IN ('public')),
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  encrypted_token TEXT NOT NULL,
  origin_mode TEXT NOT NULL CHECK (origin_mode IN ('allow-all', 'list')),
  origin_allowlist TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  enabled BOOLEAN NOT NULL DEFAULT true,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

ALTER TABLE agent_access_grants
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'public' CHECK (role IN ('public'));

ALTER TABLE agent_access_grants
  DROP COLUMN IF EXISTS scopes;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_access_grants_token_hash_key'
  ) THEN
    ALTER TABLE agent_access_grants
      ADD CONSTRAINT agent_access_grants_token_hash_key UNIQUE (token_hash);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_access_grants_agent_id
  ON agent_access_grants (agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_access_grants_workspace_id
  ON agent_access_grants (workspace_id);

-- No SQL backfill of existing embed/anonymous tokens. Legacy tokens keep working
-- via the read-path fallback in resolveAnonymousSession, and are migrated lazily into
-- properly-encrypted grants by AgentService.syncPublicLaunchGrant on the next agent
-- create/update (the application layer has WORKSPACE_TOKEN_SECRET; a SQL migration does
-- not, which is why an eager backfill could only store an empty encrypted_token).
