-- Topic census: batch clustering of recent question facets into topics.
-- Embedding columns are TYPELESS on purpose (chunk_embeddings / 128
-- convention): facet embedding width follows the workspace's active
-- embedding profile, and this feature never performs a nearest-neighbour
-- search, so no HNSW/IVFFlat index is created on any table below. Runs
-- read a bounded window into memory and cluster there.

CREATE TABLE IF NOT EXISTS topic_census_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  question_count INTEGER NOT NULL,
  unclassified_count INTEGER NOT NULL DEFAULT 0,
  seed TEXT NOT NULL,
  params_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_topic_census_runs_workspace_created
  ON topic_census_runs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_facets (
  message_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  facet_text TEXT NOT NULL,
  embedding VECTOR,
  dimensions INTEGER,
  prompt_version TEXT NOT NULL,
  embedding_profile_id UUID REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE,
  CHECK (embedding IS NULL OR vector_dims(embedding) = dimensions)
);

CREATE INDEX IF NOT EXISTS idx_message_facets_workspace_prompt_version
  ON message_facets (workspace_id, prompt_version);

CREATE TABLE IF NOT EXISTS topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  centroid VECTOR NOT NULL,
  dimensions INTEGER NOT NULL,
  radius DOUBLE PRECISION NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_run_id UUID NOT NULL,
  last_seen_run_id UUID NOT NULL,
  dissolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (vector_dims(centroid) = dimensions),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, created_run_id) REFERENCES topic_census_runs(workspace_id, id),
  FOREIGN KEY (workspace_id, last_seen_run_id) REFERENCES topic_census_runs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_topics_workspace_active
  ON topics (workspace_id)
  WHERE dissolved_at IS NULL;

CREATE TABLE IF NOT EXISTS topic_memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES topic_census_runs(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  distance DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (run_id, message_id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES topic_census_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_memberships_run_topic
  ON topic_memberships (run_id, topic_id);

CREATE TABLE IF NOT EXISTS topic_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES topic_census_runs(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('survived', 'split', 'merged', 'emerged', 'dissolved')),
  parent_topic_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, run_id) REFERENCES topic_census_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_topic_transitions_run
  ON topic_transitions (run_id);

CREATE TABLE IF NOT EXISTS facet_extraction_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, message_id) REFERENCES messages(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_facet_extraction_jobs_claim
  ON facet_extraction_jobs (status, scheduled_at);
