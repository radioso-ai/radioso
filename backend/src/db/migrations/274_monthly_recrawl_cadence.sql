-- Monthly website recrawl. A website source can now recrawl every 30 days, the only scheduled
-- cadence the free plan allows. document_sources.recrawl_cadence admits 'monthly' next to 'off',
-- 'weekly' and 'daily'.
--
-- Locks. The runner applies a file in one transaction, so the ACCESS EXCLUSIVE lock the ALTER takes
-- on document_sources is held until it commits. The CHECK is swapped in NOT VALID, which binds new
-- rows at once without scanning the old ones, so the lock is held for milliseconds. 275 validates
-- it after this commits, under a lock no read or write waits for. Every existing row satisfies the
-- new CHECK, which only widens the old one. The wait for the lock is bounded to three seconds; a
-- deploy that hits the bound rolls back and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE document_sources
  DROP CONSTRAINT document_sources_recrawl_cadence_check,
  ADD CONSTRAINT document_sources_recrawl_cadence_check
    CHECK (recrawl_cadence IN ('off', 'monthly', 'weekly', 'daily')) NOT VALID;
