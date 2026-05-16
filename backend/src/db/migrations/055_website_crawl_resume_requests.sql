ALTER TABLE website_crawl_jobs
  ADD COLUMN IF NOT EXISTS resume_requested_at TIMESTAMPTZ;
