-- Tool images: the pictures a reply's cards show from a skill's result, copied for the
-- conversation that showed them (#1763).
--
-- A row is one picture. `url` is an address a record the skill returned named: its row is written
-- in the reply's own transaction with the assistant message, and `source_url` is kept only until
-- the picture is copied, then cleared, because third-party links are often signed. `inline` is a
-- picture the skill returned as bytes: they are uploaded untouched while the tool call runs
-- (`source_object`, `{bucket, objectPath, generation}`), the row is written then, unbound, and
-- the reply that shows it binds it to its message. A row starts `pending`; a capture claims it
-- (`capturing`, `claimed_at`), fetches or reads the source, re-encodes it to WebP renditions
-- (`renditions`, the same shape as `document_images.renditions`) and marks it `stored`, or
-- `failed` with a reason. Only stored rows are ever served.
--
-- `id` doubles as the capability the public image route serves by, so it is random, never derived
-- from the source. Rows follow their conversation: its erasure deletes them and hands their
-- objects to a deletion job, and the foreign key cascades as well. A Test Chat reply has no
-- conversation row, so its pictures are written with none and no message. A message deleted on
-- its own leaves its pictures unbound, and a picture no message took is deleted 24 hours after it
-- was written, by the conversation retention sweep, which also hands its objects to the deletion
-- job.
--
-- Locks: one new table, whose foreign keys take SHARE ROW EXCLUSIVE on workspaces, conversations
-- and messages for the instant it is created. The wait is bounded; a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE conversation_tool_images (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('url', 'inline')),
  source_url TEXT CHECK (source_url IS NULL OR length(source_url) BETWEEN 1 AND 2048),
  source_object JSONB CHECK (source_object IS NULL OR jsonb_typeof(source_object) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'capturing', 'stored', 'failed')),
  claimed_at TIMESTAMPTZ,
  failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z_]{1,40}$'),
  width INTEGER CHECK (width > 0),
  height INTEGER CHECK (height > 0),
  sha256 TEXT CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  renditions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(renditions) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  stored_at TIMESTAMPTZ,
  CONSTRAINT conversation_tool_images_stored_complete CHECK (
    status <> 'stored'
    OR (width IS NOT NULL AND height IS NOT NULL AND sha256 IS NOT NULL AND renditions <> '[]'::jsonb AND stored_at IS NOT NULL)
  ),
  -- An address is kept until the picture is stored or given up on, and never after it is stored.
  CONSTRAINT conversation_tool_images_url_source CHECK (
    source_kind <> 'url'
    OR (status IN ('stored', 'failed') AND source_url IS NULL)
    OR (status IN ('pending', 'capturing') AND source_url IS NOT NULL)
  ),
  CONSTRAINT conversation_tool_images_inline_source CHECK (
    source_kind <> 'inline' OR (source_url IS NULL AND conversation_id IS NOT NULL)
  ),
  CONSTRAINT conversation_tool_images_message_in_conversation CHECK (message_id IS NULL OR conversation_id IS NOT NULL),
  CONSTRAINT conversation_tool_images_claim_complete CHECK ((status = 'capturing') = (claimed_at IS NOT NULL))
);

-- The workspace's cascade.
CREATE INDEX conversation_tool_images_workspace_idx ON conversation_tool_images (workspace_id);

-- A conversation's pictures: its erasure and the cascade.
CREATE INDEX conversation_tool_images_conversation_idx ON conversation_tool_images (conversation_id) WHERE conversation_id IS NOT NULL;

-- The message's SET NULL.
CREATE INDEX conversation_tool_images_message_idx ON conversation_tool_images (message_id) WHERE message_id IS NOT NULL;

-- The unbound sweep: pictures no message carries, oldest first.
CREATE INDEX conversation_tool_images_unbound_idx ON conversation_tool_images (created_at) WHERE message_id IS NULL;
