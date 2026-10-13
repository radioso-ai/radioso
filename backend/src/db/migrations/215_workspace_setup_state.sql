CREATE TABLE IF NOT EXISTS workspace_setup_state (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  purpose TEXT NULL,
  dismissed_at TIMESTAMPTZ NULL,
  notify_receipt_confirmed_at TIMESTAMPTZ NULL,
  skipped_steps TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (purpose IS NULL OR NULLIF(BTRIM(purpose), '') IS NOT NULL)
);
