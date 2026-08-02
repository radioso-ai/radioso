-- radioso:migration-transaction: off
-- Build the tenant-qualified key without blocking conversation writes. Dropping
-- first makes the migration restart-safe after a timed-out concurrent build leaves
-- an invalid index behind.
DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_workspace_id_unique;
-- radioso:migration-statement-break
CREATE UNIQUE INDEX CONCURRENTLY idx_conversations_workspace_id_unique
  ON conversations (workspace_id, id);
