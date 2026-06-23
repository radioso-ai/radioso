CREATE TABLE IF NOT EXISTS slack_operator_identities (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES slack_installations(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slack_display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (installation_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_operator_identities_workspace_account
  ON slack_operator_identities (workspace_id, account_id);
