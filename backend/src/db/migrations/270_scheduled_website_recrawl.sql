-- Scheduled website recrawl. A website source can recrawl itself on a cadence the operator picks,
-- and a scheduled crawl that would remove a large share of a source's pages holds them for review
-- instead of deleting them.
--
-- document_sources.recrawl_cadence is the operator's choice: 'off' (the default for every source,
-- new and existing), 'daily' or 'weekly'. next_recrawl_at is when the recrawl sweep next queues a
-- crawl for the source; it is null while the cadence is off. These are columns rather than config
-- keys because the sweep selects on them, through the partial index below.
--
-- website_crawl_jobs.crawl_trigger records who started a crawl: 'manual' for the operator, API or
-- Ray, 'scheduled' for the sweep. Only a scheduled crawl holds missing pages. Rows written before
-- this migration are manual crawls.
--
-- website_source_missing_pages lists pages a scheduled crawl found missing but did not delete:
-- 'pending' until the operator decides, 'kept' once the operator keeps them. A kept page is never
-- held or deleted by a later scheduled crawl; a page seen again on the site leaves the list. The
-- row goes with its document.
--
-- Locks. The file is one transaction, so each lock is held until it commits. Adding a column with a
-- constant default and a CHECK takes an ACCESS EXCLUSIVE lock on document_sources and
-- website_crawl_jobs; both are small. The new table's foreign keys take SHARE ROW EXCLUSIVE locks on
-- documents, workspaces and document_sources, which block writes to them, not reads, until the
-- commit. The wait for each lock is bounded to three seconds; a deploy that hits it rolls back and a
-- retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE document_sources
  ADD COLUMN recrawl_cadence TEXT NOT NULL DEFAULT 'off'
    CONSTRAINT document_sources_recrawl_cadence_check CHECK (recrawl_cadence IN ('off', 'daily', 'weekly')),
  ADD COLUMN next_recrawl_at TIMESTAMPTZ NULL;

CREATE INDEX idx_document_sources_due_recrawl
  ON document_sources (next_recrawl_at)
  WHERE kind = 'website' AND recrawl_cadence <> 'off';

ALTER TABLE website_crawl_jobs
  ADD COLUMN crawl_trigger TEXT NOT NULL DEFAULT 'manual'
    CONSTRAINT website_crawl_jobs_crawl_trigger_check CHECK (crawl_trigger IN ('manual', 'scheduled'));

CREATE TABLE website_source_missing_pages (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
  missing_since TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'kept')),
  decided_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_website_source_missing_pages_source
  ON website_source_missing_pages (workspace_id, source_id, decision);
