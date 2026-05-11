CREATE TABLE IF NOT EXISTS website_crawl_jobs (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id UUID REFERENCES document_sources(id) ON DELETE SET NULL,
  requested_url TEXT NOT NULL,
  crawl_limit INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json JSONB,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_website_crawl_jobs_claim
  ON website_crawl_jobs (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_website_crawl_jobs_workspace_created
  ON website_crawl_jobs (workspace_id, created_at DESC);
