CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_memberships (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS account_invitations (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_by_membership_id UUID NOT NULL REFERENCES account_memberships(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

INSERT INTO users (id, email, password_hash, created_at, updated_at)
SELECT a.id, a.email, a.password_hash, a.created_at, a.updated_at
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1
  FROM users u
  WHERE u.id = a.id
);

INSERT INTO account_memberships (id, account_id, user_id, role, status, created_at, updated_at)
SELECT gen_random_uuid(), a.id, a.id, 'owner', 'active', a.created_at, a.updated_at
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1
  FROM account_memberships m
  WHERE m.account_id = a.id
    AND m.user_id = a.id
);

UPDATE sessions
SET user_id = account_id
WHERE user_id IS NULL;

ALTER TABLE sessions
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_memberships_account_status
  ON account_memberships (account_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_account_memberships_user_status
  ON account_memberships (user_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_account_invitations_account_created
  ON account_invitations (account_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_invitations_pending_email
  ON account_invitations (account_id, email)
  WHERE status = 'pending';
