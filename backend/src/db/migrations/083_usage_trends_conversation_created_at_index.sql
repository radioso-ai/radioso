-- Usage trends reporting (spec 084) buckets conversations by created_at over a
-- workspace/account scope. The existing conversation indexes lead with
-- updated_at (idx_conversations_workspace_agent_updated_id, 048) or are
-- workspace-only (idx_conversations_workspace_id, 005), so neither serves a
-- created_at range scan or GROUP BY created_at; the planner falls back to a
-- sequential scan that grows with the table and is risky for this
-- member-accessible endpoint over large ranges.
--
-- EXPLAIN ANALYZE on 100k conversations / 5 workspaces (90-day window):
--   workspace-filtered: Seq Scan ~4.6ms  ->  Index-Only Scan ~1.1ms
--   account-wide:       Seq Scan ~18.3ms ->  Bitmap Index Scan ~8.9ms
-- The composite (workspace_id, created_at) serves both paths: an index-only
-- scan for the workspace-filtered COUNT, and per-workspace/bitmap scans for the
-- account-wide case via the workspaces join. A created_at-leading index was
-- rejected because it would scan cross-tenant rows for account-wide queries.
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_created_at
  ON conversations (workspace_id, created_at);
