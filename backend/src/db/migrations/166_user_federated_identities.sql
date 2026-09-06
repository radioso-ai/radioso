-- Records which external identity providers a user can sign in with.
-- The provider subject is the identifier of record: it is stable for the life
-- of the provider account, while the address on it can be reassigned. Keeping
-- the link lets a returning user reach the account they already have after
-- their address changes, and lets the join flow offer the provider to someone
-- whose login has no password to type.
CREATE TABLE IF NOT EXISTS user_federated_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_authenticated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One provider account belongs to one user. A user may hold several accounts
  -- at the same provider, so the pair is the only uniqueness that holds.
  UNIQUE (provider, subject)
);

CREATE INDEX IF NOT EXISTS idx_user_federated_identities_user
  ON user_federated_identities (user_id);
