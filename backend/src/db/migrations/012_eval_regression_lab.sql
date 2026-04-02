CREATE TABLE IF NOT EXISTS eval_datasets (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_by_account_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eval_datasets_workspace_updated_idx
ON eval_datasets (workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS eval_cases (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES eval_datasets(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  query TEXT NOT NULL,
  conversation_context JSONB NOT NULL DEFAULT '[]'::jsonb,
  expectations JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eval_cases_dataset_created_idx
ON eval_cases (dataset_id, created_at ASC);

CREATE TABLE IF NOT EXISTS eval_runs (
  id UUID PRIMARY KEY,
  dataset_id UUID NOT NULL REFERENCES eval_datasets(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NULL,
  baseline_run_id UUID NULL REFERENCES eval_runs(id) ON DELETE SET NULL,
  created_by_account_id UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  run_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS eval_runs_dataset_completed_idx
ON eval_runs (dataset_id, completed_at DESC);
