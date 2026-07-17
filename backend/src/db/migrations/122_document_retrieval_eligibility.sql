-- Per-document retrieval eligibility. A document can be manually disabled for
-- retrieval (independent of its processing status) and/or given an expiry after
-- which it is auto-disabled. Both are orthogonal to `status`: a disabled or
-- expired document stays 'ready' and visible in the dashboard, it is simply not
-- a retrieval candidate. The retrieval filter reads:
--   status = 'ready'
--   AND retrieval_enabled = true
--   AND (retrieval_expires_at IS NULL OR retrieval_expires_at > now())
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS retrieval_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS retrieval_expires_at timestamptz;
