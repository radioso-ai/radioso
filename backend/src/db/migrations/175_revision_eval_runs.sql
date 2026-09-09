-- Durable, private evaluation evidence for immutable agent candidates.  This is separate from
-- eval_runs so candidate experiments can never change a case's ordinary last-run evidence.
CREATE TABLE revision_eval_runs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  actor_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('retrieval_only', 'full_assistant')),
  execution_policy TEXT NOT NULL CHECK (execution_policy = 'safe_test'),
  test_values JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'partial', 'failed', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_revision_eval_runs_scope ON revision_eval_runs (workspace_id, agent_id, created_at DESC);

CREATE TABLE revision_eval_run_sides (
  id UUID PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES revision_eval_runs(id) ON DELETE CASCADE,
  revision_id UUID NOT NULL REFERENCES agent_revisions(id) ON DELETE RESTRICT,
  side_ordinal INTEGER NOT NULL CHECK (side_ordinal >= 0),
  frozen_revision JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'partial', 'failed', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, revision_id),
  UNIQUE (run_id, side_ordinal)
);

CREATE TABLE revision_eval_run_cases (
  id UUID PRIMARY KEY,
  side_id UUID NOT NULL REFERENCES revision_eval_run_sides(id) ON DELETE CASCADE,
  case_id UUID NOT NULL REFERENCES eval_cases(id) ON DELETE RESTRICT,
  frozen_case JSONB NOT NULL,
  frozen_snapshot JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'failed', 'completed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'partial', 'unavailable')),
  assertion_verdicts JSONB,
  observed_output JSONB,
  resolved_config JSONB,
  outcome_reason TEXT,
  active_attempt_id UUID,
  active_fence INTEGER,
  lease_expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (side_id, case_id)
);
CREATE INDEX idx_revision_eval_run_cases_claim ON revision_eval_run_cases (state, lease_expires_at);

CREATE TABLE revision_eval_run_attempts (
  id UUID PRIMARY KEY,
  run_case_id UUID NOT NULL REFERENCES revision_eval_run_cases(id) ON DELETE CASCADE,
  fence INTEGER NOT NULL CHECK (fence > 0),
  state TEXT NOT NULL CHECK (state IN ('running', 'failed', 'completed')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_case_id, fence)
);
