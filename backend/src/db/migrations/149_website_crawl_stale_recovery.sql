CREATE INDEX IF NOT EXISTS idx_website_crawl_jobs_stale_processing
  ON website_crawl_jobs (claimed_at, updated_at, id)
  INCLUDE (workspace_id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_website_crawl_jobs_stale_paused_claim
  ON website_crawl_jobs (claimed_at, updated_at, id)
  INCLUDE (workspace_id)
  WHERE status = 'paused' AND resume_requested_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_website_crawl_jobs_stale_paused_resume
  ON website_crawl_jobs (resume_requested_at, updated_at, id)
  INCLUDE (workspace_id)
  WHERE status = 'paused' AND resume_requested_at IS NOT NULL;
