CREATE TABLE IF NOT EXISTS agent_directives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  condition_kind TEXT NOT NULL,
  condition_description TEXT NULL,
  action TEXT NOT NULL,
  priority INTEGER NULL,
  criticality TEXT NULL,
  required_capabilities TEXT[] NOT NULL DEFAULT '{}',
  depends_on TEXT[] NOT NULL DEFAULT '{}',
  excludes TEXT[] NOT NULL DEFAULT '{}',
  routes TEXT[] NOT NULL DEFAULT '{}',
  description TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, name),
  CHECK (condition_kind IN ('always', 'contextual')),
  CHECK (
    (condition_kind = 'always' AND condition_description IS NULL)
    OR (condition_kind = 'contextual' AND NULLIF(BTRIM(condition_description), '') IS NOT NULL)
  ),
  CHECK (criticality IS NULL OR criticality IN ('low', 'medium', 'high'))
);

CREATE INDEX IF NOT EXISTS idx_agent_directives_agent_id ON agent_directives (agent_id);
