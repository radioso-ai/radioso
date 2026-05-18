-- Auth email tokens are intentionally cut over from the former Enterprise
-- tables to these OSS tables without copying ee_password_reset_tokens or
-- ee_email_verification_tokens. Any reset or verification links issued before
-- this migration must be requested again after deployment.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  request_ip TEXT,
  request_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_created
  ON password_reset_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_active
  ON password_reset_tokens (user_id, expires_at DESC)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  request_ip TEXT,
  request_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_created
  ON email_verification_tokens (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_active
  ON email_verification_tokens (user_id, expires_at DESC)
  WHERE used_at IS NULL;
