-- Phase 2: move the durable usage-event ledger from the Enterprise module into
-- the OSS substrate. On installs that previously ran the EE usage-limit
-- migrator the `ee_usage_*` event tables already exist with data; rename them
-- in place (preserving rows, the idempotency unique index, and foreign keys).
-- On fresh installs the renames are no-ops and the CREATE statements build the
-- tables. The EE migrator no longer creates these tables (it keeps only the
-- usage-LIMIT tables), and this OSS migration runs before EE migrators at boot,
-- so the two never conflict.

ALTER TABLE IF EXISTS ee_usage_events RENAME TO usage_events;
ALTER TABLE IF EXISTS ee_embedding_usage_items RENAME TO embedding_usage_items;
ALTER TABLE IF EXISTS ee_usage_daily_rollups RENAME TO usage_daily_rollups;

-- Normalize index names carried over from the renamed tables (no-op on fresh installs).
ALTER INDEX IF EXISTS idx_ee_usage_events_account_occurred_at RENAME TO idx_usage_events_account_occurred_at;
ALTER INDEX IF EXISTS idx_ee_usage_events_account_operation_day RENAME TO idx_usage_events_account_operation_day;
ALTER INDEX IF EXISTS idx_ee_usage_events_workspace_occurred_at RENAME TO idx_usage_events_workspace_occurred_at;
ALTER INDEX IF EXISTS idx_ee_usage_events_conversation_id RENAME TO idx_usage_events_conversation_id;

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id UUID REFERENCES document_sources(id) ON DELETE SET NULL,
  document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
  document_revision INTEGER,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  job_id UUID,
  surface TEXT NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  input_bytes BIGINT NOT NULL DEFAULT 0,
  output_bytes BIGINT NOT NULL DEFAULT 0,
  vector_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  usage_quality TEXT NOT NULL,
  provider_request_id TEXT,
  error_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_account_occurred_at
  ON usage_events (account_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_account_operation_day
  ON usage_events (account_id, operation, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_occurred_at
  ON usage_events (workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_conversation_id
  ON usage_events (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS embedding_usage_items (
  usage_event_id UUID NOT NULL REFERENCES usage_events(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  document_revision INTEGER NOT NULL,
  chunk_id UUID,
  chunk_index INTEGER NOT NULL,
  content_bytes BIGINT NOT NULL,
  estimated_tokens BIGINT,
  PRIMARY KEY (usage_event_id, document_id, document_revision, chunk_index)
);

CREATE TABLE IF NOT EXISTS usage_daily_rollups (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  input_bytes BIGINT NOT NULL DEFAULT 0,
  output_bytes BIGINT NOT NULL DEFAULT 0,
  vector_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, usage_date, operation, provider, model)
);
