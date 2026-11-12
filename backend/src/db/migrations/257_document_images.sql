-- Document images: the pictures a document's content carries, captured with the content so an
-- answer grounded in the document can present them as reply blocks (#1763).
--
-- A row is one image the content names or embeds: a metadata image (a page's `og:image`, a
-- WordPress featured image) is the document's `primary` image; an image inside the text is
-- `inline`, anchored to the chunk whose text surrounds it. A row starts `pending` when its image
-- is found and becomes `stored` once its re-encoded renditions are written; only stored rows are
-- ever shown. `renditions` lists the stored copies, one per width
-- (`[{width, height, bucket, objectPath, generation, sizeBytes}]`); the rows own those object
-- paths, so deleting a document's images goes through its rows.
--
-- `id` doubles as the capability the public image route serves by, so it is random, never derived
-- from the source. `chunk_id` carries no foreign key: chunks are rebuilt on every revision, and the
-- capture job re-anchors the row from `text_offset`. Rows follow their document: deleting or
-- re-syncing it deletes them, and a workspace's documents go with the workspace.
--
-- Locks: one new table, whose foreign key takes SHARE ROW EXCLUSIVE on documents for the instant
-- it is created. The wait is bounded; a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE document_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id UUID,
  role TEXT NOT NULL CHECK (role IN ('primary', 'inline')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'stored')),
  position INTEGER NOT NULL CHECK (position >= 0),
  text_offset INTEGER CHECK (text_offset >= 0),
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  source_etag TEXT,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT,
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  sha256 TEXT,
  renditions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(renditions) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_images_document_source_key UNIQUE (document_id, source_url),
  CONSTRAINT document_images_stored_complete CHECK (
    status <> 'stored'
    OR (width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL AND renditions <> '[]'::jsonb)
  )
);

-- An answer reads a document's primary image, and the inline images of the chunks it cites.
CREATE INDEX document_images_stored_primary_idx
  ON document_images (document_id, position)
  WHERE status = 'stored' AND role = 'primary';

CREATE INDEX document_images_stored_inline_chunk_idx
  ON document_images (chunk_id)
  WHERE status = 'stored' AND role = 'inline';
