-- Feature 087 US2: OAuth-authenticated MCP connections.
-- Transient PKCE/state for an in-flight authorization (encrypted via
-- fieldEncryption), cleared once the connection becomes authorized. The durable
-- OAuth client config lives in the existing oauth_client_ciphertext column and
-- the tokens in credential_ciphertext.

ALTER TABLE mcp_connections
  ADD COLUMN IF NOT EXISTS oauth_flow_ciphertext TEXT;
