ALTER TABLE website_crawl_jobs
  ADD COLUMN IF NOT EXISTS policy_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_website_crawl_jobs_source_status
  ON website_crawl_jobs (workspace_id, source_id, status, updated_at DESC);
