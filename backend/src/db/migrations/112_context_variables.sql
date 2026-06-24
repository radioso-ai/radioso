CREATE TABLE IF NOT EXISTS context_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('string', 'json')),
  trust_tier TEXT NOT NULL CHECK (trust_tier IN ('unverified', 'signed')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'sensitive')),
  default_surfacing TEXT NOT NULL CHECK (default_surfacing IN ('always', 'on_reference', 'operator_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS agent_context_variables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  variable_id UUID NOT NULL REFERENCES context_variables(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('pushed', 'browser', 'resolver')),
  resolver_skill_id UUID NULL,
  max_age_seconds INTEGER NULL,
  resolver_timeout_ms INTEGER NULL,
  surfacing TEXT NOT NULL CHECK (surfacing IN ('always', 'on_reference', 'operator_only')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, variable_id),
  CHECK (
    (source = 'resolver' AND resolver_skill_id IS NOT NULL)
    OR (source <> 'resolver' AND resolver_skill_id IS NULL)
  ),
  CHECK (
    source = 'resolver'
    OR (max_age_seconds IS NULL AND resolver_timeout_ms IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS context_variable_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  variable_id UUID NOT NULL REFERENCES context_variables(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('session', 'customer', 'agent', 'workspace')),
  scope_id TEXT NOT NULL,
  data JSONB NOT NULL,
  last_modified TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (variable_id, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_context_variable_values_workspace_variable_scope
  ON context_variable_values (workspace_id, variable_id, scope_type, scope_id);
