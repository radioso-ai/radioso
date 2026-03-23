CREATE TABLE IF NOT EXISTS ingestion_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  chunking_strategy TEXT NOT NULL DEFAULT 'fixed_window',
  fixed_window_chunk_size INTEGER NOT NULL DEFAULT 800,
  fixed_window_chunk_overlap INTEGER NOT NULL DEFAULT 120,
  structured_min_chunk_size INTEGER NOT NULL DEFAULT 24,
  structured_max_chunk_size INTEGER NOT NULL DEFAULT 220,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ingestion_settings (
  workspace_id,
  chunking_strategy,
  fixed_window_chunk_size,
  fixed_window_chunk_overlap,
  structured_min_chunk_size,
  structured_max_chunk_size
)
SELECT
  workspace_id,
  chunking_strategy,
  800,
  120,
  24,
  220
FROM retrieval_settings
WHERE workspace_id IS NOT NULL
ON CONFLICT (workspace_id) DO NOTHING;
