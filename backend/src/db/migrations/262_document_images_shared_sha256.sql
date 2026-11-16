-- Pictures embedded in uploaded files (#1763): a logo at the top of every uploaded letter is an
-- inline image many documents carry, as a site banner is a primary image many pages name. An
-- answer shows neither as a document's own, so how many documents carry one stored picture in the
-- same role is counted for inline images too.
--
-- The covering index the count reads gains the role as a key column and drops its primary-only
-- predicate.
--
-- Locks: SHARE on document_images while the index builds, ACCESS EXCLUSIVE for the instant the old
-- one is dropped. The table holds a few rows per document; the wait is bounded and a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE INDEX document_images_stored_sha256_idx
  ON document_images (workspace_id, role, sha256) INCLUDE (document_id)
  WHERE status = 'stored' AND document_id IS NOT NULL;

DROP INDEX document_images_stored_primary_sha256_idx;
