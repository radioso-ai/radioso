CREATE TABLE IF NOT EXISTS routine_definition (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  activation_trigger_description TEXT NOT NULL,
  activation_gate_ref TEXT NULL,
  activation_priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, name, version),
  CHECK (version > 0),
  CHECK (status IN ('draft', 'published')),
  CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CHECK (NULLIF(BTRIM(activation_trigger_description), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS routine_slot (
  definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
  stable_slot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  description TEXT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (definition_id, stable_slot_id),
  UNIQUE(definition_id, key),
  UNIQUE(definition_id, ordinal),
  CHECK (NULLIF(BTRIM(stable_slot_id), '') IS NOT NULL),
  CHECK (NULLIF(BTRIM(key), '') IS NOT NULL),
  CHECK (type IN ('text', 'number', 'boolean', 'email', 'date')),
  CHECK (ordinal >= 0)
);

CREATE TABLE IF NOT EXISTS routine_step (
  definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
  stable_step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  tool_ref TEXT NULL,
  ordinal INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (definition_id, stable_step_id),
  UNIQUE(definition_id, ordinal),
  CHECK (kind IN ('chat', 'tool', 'fork')),
  CHECK (NULLIF(BTRIM(stable_step_id), '') IS NOT NULL),
  CHECK (NULLIF(BTRIM(instruction), '') IS NOT NULL),
  CHECK (ordinal >= 0)
);

CREATE TABLE IF NOT EXISTS routine_transition (
  definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
  from_step TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  guard_kind TEXT NOT NULL,
  guard_text TEXT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (definition_id, from_step, ordinal),
  CHECK (NULLIF(BTRIM(from_step), '') IS NOT NULL),
  CHECK (NULLIF(BTRIM(to_ref), '') IS NOT NULL),
  CHECK (guard_kind IN ('llm', 'always', 'fallback')),
  CHECK (ordinal >= 0)
);

CREATE TABLE IF NOT EXISTS routine_terminal (
  definition_id UUID NOT NULL REFERENCES routine_definition(id) ON DELETE CASCADE,
  stable_step_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NULL,
  action_type TEXT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (definition_id, stable_step_id),
  UNIQUE(definition_id, ordinal),
  CHECK (kind IN ('complete', 'handoff', 'action')),
  CHECK (NULLIF(BTRIM(stable_step_id), '') IS NOT NULL),
  CHECK (ordinal >= 0),
  CHECK (
    (kind = 'action' AND NULLIF(BTRIM(action_type), '') IS NOT NULL)
    OR (kind <> 'action')
  )
);

CREATE INDEX IF NOT EXISTS idx_routine_definition_agent_id ON routine_definition (agent_id);
CREATE INDEX IF NOT EXISTS idx_routine_definition_agent_status_priority
  ON routine_definition (agent_id, status, activation_priority DESC, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_routine_slot_definition_id ON routine_slot (definition_id);
CREATE INDEX IF NOT EXISTS idx_routine_step_definition_id ON routine_step (definition_id);
CREATE INDEX IF NOT EXISTS idx_routine_transition_definition_id ON routine_transition (definition_id);
CREATE INDEX IF NOT EXISTS idx_routine_terminal_definition_id ON routine_terminal (definition_id);
