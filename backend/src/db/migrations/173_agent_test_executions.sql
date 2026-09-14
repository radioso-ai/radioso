-- Durable, operator-only evidence for immutable agent revision tests. Content is
-- intentionally isolated from public conversation/message history and audit payloads.
CREATE TABLE agent_test_executions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('single', 'compare')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('running', 'partial', 'failed', 'completed')),
  test_values JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_test_executions_scope ON agent_test_executions (workspace_id, agent_id, created_at DESC);

CREATE TABLE agent_test_execution_sides (
  id UUID PRIMARY KEY,
  execution_id UUID NOT NULL REFERENCES agent_test_executions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_revisions(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'failed', 'completed')),
  retryable BOOLEAN NOT NULL DEFAULT false,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  continuation JSONB,
  active_turn_id UUID,
  active_attempt_id UUID,
  active_fence INTEGER,
  side_ordinal INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_test_execution_sides_active_attempt_check CHECK (
    (active_turn_id IS NULL AND active_attempt_id IS NULL AND active_fence IS NULL)
    OR (active_turn_id IS NOT NULL AND active_attempt_id IS NOT NULL AND active_fence > 0)
  ),
  UNIQUE (execution_id, revision_id),
  UNIQUE (conversation_id),
  UNIQUE (execution_id, side_ordinal)
);
CREATE INDEX idx_agent_test_execution_sides_execution ON agent_test_execution_sides (execution_id);

CREATE TABLE agent_test_execution_turns (
  execution_id UUID NOT NULL REFERENCES agent_test_executions(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  message TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'partial', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, turn_id)
);

CREATE TABLE agent_test_execution_attempts (
  execution_id UUID NOT NULL REFERENCES agent_test_executions(id) ON DELETE CASCADE,
  side_id UUID NOT NULL REFERENCES agent_test_execution_sides(id) ON DELETE CASCADE,
  turn_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  input_fingerprint TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence > 0),
  state TEXT NOT NULL CHECK (state IN ('running', 'failed', 'completed')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  result JSONB,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execution_id, side_id, turn_id, attempt_id),
  FOREIGN KEY (execution_id, turn_id)
    REFERENCES agent_test_execution_turns(execution_id, turn_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_test_execution_attempts_recovery
  ON agent_test_execution_attempts (execution_id, side_id, turn_id, state, lease_expires_at);
