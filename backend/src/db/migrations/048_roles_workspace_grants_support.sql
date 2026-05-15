CREATE TABLE IF NOT EXISTS workspace_grants (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);

ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

ALTER TABLE account_invitations
  DROP CONSTRAINT IF EXISTS account_invitations_role_check;

ALTER TABLE account_invitations
  ADD CONSTRAINT account_invitations_role_check CHECK (role IN ('admin', 'member'));

CREATE INDEX IF NOT EXISTS idx_workspace_grants_account_id
  ON workspace_grants (account_id);

CREATE INDEX IF NOT EXISTS idx_workspace_grants_user_id
  ON workspace_grants (user_id);
