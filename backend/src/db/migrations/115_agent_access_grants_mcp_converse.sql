ALTER TABLE agent_access_grants
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'public-link';

UPDATE agent_access_grants
SET channel = 'public-link'
WHERE channel IS NULL OR channel = 'mcp-converse';

ALTER TABLE agent_access_grants
  DROP CONSTRAINT IF EXISTS agent_access_grants_channel_check;

ALTER TABLE agent_access_grants
  ADD CONSTRAINT agent_access_grants_channel_check
  CHECK (channel IN ('embed', 'public-link', 'mcp-converse'));

ALTER TABLE agent_access_grants
  DROP CONSTRAINT IF EXISTS agent_access_grants_role_check;

ALTER TABLE agent_access_grants
  ADD CONSTRAINT agent_access_grants_role_check
  CHECK (role IN ('public', 'agent'));
