ALTER TABLE api_credentials
  ALTER COLUMN expires_at DROP NOT NULL;

DROP INDEX IF EXISTS idx_api_credentials_expiry_warning_scan;

CREATE INDEX IF NOT EXISTS idx_api_credentials_expiry_warning_scan
  ON api_credentials (expires_at, id)
  WHERE revoked_at IS NULL AND expires_at IS NOT NULL;
