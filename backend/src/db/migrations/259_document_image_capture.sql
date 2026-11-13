-- Document image capture (#1763): the worker fetches the images a document's content names and
-- fills the `document_images` rows that ingestion records.
--
-- `skipped` is an image capture will not keep: too small, not a raster type it reads, too large,
-- or refused by the public-network policy. The row stays so a re-sync of the same content does
-- not fetch it again; it is never shown.
--
-- A deleted document releases its images instead of taking the rows with it: `document_id` turns
-- NULL, the image stops being served at once, and the document worker deletes the stored copies
-- the row lists, then the row. Every way a document is deleted (one at a time, with its source,
-- by a crawl that no longer finds the page, with its workspace) therefore cleans up the same way.
--
-- An answer does not show a picture as a document's own when many documents in the workspace name
-- the same image as theirs (a site-wide banner), so stored primary images are indexed by content
-- hash within a workspace.
--
-- Locks: ACCESS EXCLUSIVE on document_images, a new and small table, and SHARE ROW EXCLUSIVE on
-- documents for the instant the foreign key is re-created. The wait is bounded; a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE document_images DROP CONSTRAINT document_images_status_check;
ALTER TABLE document_images
  ADD CONSTRAINT document_images_status_check CHECK (status IN ('pending', 'stored', 'skipped'));

ALTER TABLE document_images ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE document_images DROP CONSTRAINT document_images_document_id_fkey;
ALTER TABLE document_images
  ADD CONSTRAINT document_images_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL;

-- The worker's sweep reads released rows oldest first.
CREATE INDEX document_images_released_idx
  ON document_images (updated_at)
  WHERE document_id IS NULL;

-- How many documents in a workspace name one stored image as their primary, answered from the
-- index alone: the document is included, and the count stops a few past the banner threshold.
CREATE INDEX document_images_stored_primary_sha256_idx
  ON document_images (workspace_id, sha256) INCLUDE (document_id)
  WHERE status = 'stored' AND role = 'primary' AND document_id IS NOT NULL;
