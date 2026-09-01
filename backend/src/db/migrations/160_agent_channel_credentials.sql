ALTER TABLE agent_access_grants
  ALTER COLUMN encrypted_token DROP NOT NULL;

-- API credentials issued before expiry became mandatory are invalidated rather
-- than silently gaining an operator-chosen lifetime. Service identities and
-- user accounts remain intact; only their non-expiring secrets stop working.
UPDATE api_credentials
SET expires_at = now(),
    revoked_at = COALESCE(revoked_at, now()),
    revocation_reason = COALESCE(revocation_reason, 'explicit')
WHERE expires_at IS NULL;

ALTER TABLE api_credentials
  ALTER COLUMN expires_at SET NOT NULL;

DROP INDEX IF EXISTS idx_api_credentials_expiry_warning_scan;
CREATE INDEX idx_api_credentials_expiry_warning_scan
  ON api_credentials (expires_at, id)
  WHERE revoked_at IS NULL;

ALTER TABLE agent_access_grants
  DROP CONSTRAINT IF EXISTS agent_access_grants_channel_check;

ALTER TABLE agent_access_grants
  ADD CONSTRAINT agent_access_grants_channel_check
  CHECK (channel IN ('embed', 'public-link', 'mcp-converse', 'agent-api'));

UPDATE agent_access_grants
SET principal_kind = 'agent-api',
    encrypted_token = NULL,
    expires_at = COALESCE(expires_at, now()),
    revoked_at = COALESCE(revoked_at, now())
WHERE channel = 'mcp-converse';
