-- Credential ciphertext names the key that encrypted it (#1610), so the encryption_key_id columns
-- on webhook destinations (089), external skill MCP connections (093) and integration OAuth
-- connections (095) carry nothing: application code no longer writes or reads them.
--
-- They are not dropped here. Migrations run while the previous revision still serves traffic, and
-- that revision names encryption_key_id in its inserts and updates, so dropping a column would fail
-- its writes. workspace_webhook_destinations.encryption_key_id is NOT NULL, which would equally fail
-- inserts from this revision, so it becomes nullable. A later release drops all three once no
-- running revision writes them.
--
-- workspace_webhook_destinations is small; DROP NOT NULL is a catalog change under a brief lock.
SET LOCAL lock_timeout = '3s';

ALTER TABLE workspace_webhook_destinations
  ALTER COLUMN encryption_key_id DROP NOT NULL;

COMMENT ON COLUMN workspace_webhook_destinations.encryption_key_id IS
  'Unused: secret_ciphertext names its key. Dropped once no running revision writes it.';
COMMENT ON COLUMN mcp_connections.encryption_key_id IS
  'Unused: the ciphertext columns name their key. Dropped once no running revision writes it.';
COMMENT ON COLUMN integration_oauth_connections.encryption_key_id IS
  'Unused: the ciphertext columns name their key. Dropped once no running revision writes it.';
