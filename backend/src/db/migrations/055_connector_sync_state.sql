-- Generic per-(connector, workspace) sync state for connectors that backfill
-- and/or poll an external source. Cursor + last-run + backfill-completed
-- timestamps are common to every such connector (WordPress is the first
-- consumer; Notion, GitHub, Drive, etc. will use this same table).

CREATE TABLE IF NOT EXISTS connector_sync_state (
  connector_id TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  last_modified_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  backfill_completed_at TIMESTAMPTZ,
  PRIMARY KEY (connector_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_connector_sync_state_workspace_id
  ON connector_sync_state (workspace_id);
