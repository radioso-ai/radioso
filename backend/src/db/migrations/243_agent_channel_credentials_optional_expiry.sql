-- Agent-channel credentials (MCP and Agent API) may be issued without an expiry: a null
-- expires_at means the credential works until it is rotated or revoked. Expiry stays
-- available; it is no longer required, so the agent-api CHECK from 162 goes away.
--
-- Locks. DROP CONSTRAINT takes ACCESS EXCLUSIVE on agent_access_grants for the catalog change
-- only. The migration runner disables lock timeouts for a migration's body, so this sets its own:
-- a transaction still reading or writing the table makes the deploy fail after three seconds, and
-- the rollback leaves nothing behind, instead of queueing every grant lookup behind it. A retry
-- is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_access_grants
  DROP CONSTRAINT IF EXISTS agent_access_grants_agent_api_expiry_check;
