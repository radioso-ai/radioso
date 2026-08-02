-- radioso:migration-transaction: off
-- Build the tenant-qualified key without blocking document writes. Dropping first
-- makes the migration restart-safe after a timed-out concurrent build leaves an
-- invalid index behind.
DROP INDEX CONCURRENTLY IF EXISTS idx_documents_workspace_id_unique;
-- radioso:migration-statement-break
CREATE UNIQUE INDEX CONCURRENTLY idx_documents_workspace_id_unique
  ON documents (workspace_id, id);
