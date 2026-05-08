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

CREATE TABLE IF NOT EXISTS support_impersonation_sessions (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  staff_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approver_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('approved', 'active', 'ended', 'expired', 'revoked')),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_impersonation_sessions_account_created
  ON support_impersonation_sessions (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_impersonation_sessions_staff_status
  ON support_impersonation_sessions (staff_user_id, status, expires_at);
