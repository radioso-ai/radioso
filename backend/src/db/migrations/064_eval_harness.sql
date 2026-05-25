CREATE TABLE IF NOT EXISTS eval_snapshots (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  fidelity TEXT NOT NULL,
  messages JSONB NOT NULL,
  original_instruction_block JSONB,
  original_model_id TEXT,
  original_retrieval_settings JSONB,
  original_retrieval_result JSONB,
  original_agent_id UUID,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_by UUID,
  CONSTRAINT eval_snapshots_fidelity_check
    CHECK (fidelity IN ('full', 'messages_only'))
);

CREATE INDEX IF NOT EXISTS idx_eval_snapshots_workspace_captured_at
  ON eval_snapshots (workspace_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_snapshots_source_conversation
  ON eval_snapshots (workspace_id, source_conversation_id);

CREATE TABLE IF NOT EXISTS eval_cases (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL REFERENCES eval_snapshots(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  expected_outcome JSONB NOT NULL,
  status TEXT NOT NULL,
  last_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT eval_cases_status_check
    CHECK (status IN ('pending', 'passing', 'failing', 'error')),
  CONSTRAINT eval_cases_name_length_check
    CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_workspace_updated_at
  ON eval_cases (workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_cases_snapshot
  ON eval_cases (workspace_id, snapshot_id);

CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id UUID NOT NULL REFERENCES eval_snapshots(id) ON DELETE RESTRICT,
  case_id UUID REFERENCES eval_cases(id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  outcome_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT eval_runs_mode_check
    CHECK (mode IN ('retrieval_only', 'full_assistant')),
  CONSTRAINT eval_runs_status_check
    CHECK (status IN ('pass', 'fail', 'error', 'recorded'))
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_case
  ON eval_runs (workspace_id, case_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_runs_snapshot
  ON eval_runs (workspace_id, snapshot_id, started_at DESC);

ALTER TABLE eval_cases
  ADD CONSTRAINT eval_cases_last_run_fk
  FOREIGN KEY (last_run_id) REFERENCES eval_runs(id) ON DELETE SET NULL;
