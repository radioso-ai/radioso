-- Photos a visitor or an API caller attaches to a chat message (spec visitor-image-input).
--
-- A row is written when a photo is uploaded, before any message names it. The bytes live in
-- document storage under the workspace (workspaces/<ws>/visitor-images/<id>), re-encoded to a
-- bounded JPEG; the row holds where, how big, its digest, and what the agent's chat model read in
-- it. `owner_kind` and `owner_id` name who may send it in a turn: a public chat session, an API
-- credential, a signed-in user, or a connector conversation. The owner id is never a credential.
--
-- A send claims the photo (`claim_id`, `claimed_at`), so two messages never use one photo, and
-- then binds it to the conversation and the user message that carries it. A claim whose turn
-- stored no message is released. A photo never bound is deleted 24 hours after its upload by the
-- conversation retention sweep, which hands its object to the deletion job in the same
-- transaction; so does a conversation's erasure. A message deleted on its own (a turn a newer
-- input replaced) leaves the photo unbound, for that sweep, rather than cascading the row away
-- and stranding its object.
--
-- Locks: one new table, whose foreign keys take SHARE ROW EXCLUSIVE on workspaces, agents,
-- conversations and messages for the instant it is created. The wait is bounded; a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE visitor_images (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- An agent's deletion keeps its conversations, so it keeps their photos; an unbound one is swept.
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('public_session', 'api_credential', 'user', 'connector_conversation')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 200),
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  storage_bucket TEXT NOT NULL CHECK (length(storage_bucket) BETWEEN 1 AND 255),
  storage_object_path TEXT NOT NULL CHECK (length(storage_object_path) BETWEEN 1 AND 1024),
  storage_generation TEXT,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- `pending` until the reading call ends; `unread` when it failed, so the turn says so.
  reading_status TEXT NOT NULL DEFAULT 'pending' CHECK (reading_status IN ('pending', 'read', 'unread')),
  reading TEXT CHECK (reading IS NULL OR length(reading) BETWEEN 1 AND 4000),
  claim_id UUID,
  claimed_at TIMESTAMPTZ,
  bound_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT visitor_images_read_has_reading CHECK ((reading_status = 'read') = (reading IS NOT NULL)),
  CONSTRAINT visitor_images_claim_complete CHECK ((claim_id IS NULL) = (claimed_at IS NULL)),
  CONSTRAINT visitor_images_message_in_conversation CHECK (message_id IS NULL OR conversation_id IS NOT NULL)
);

-- The workspace's cascade.
CREATE INDEX visitor_images_workspace_idx ON visitor_images (workspace_id);

-- The agent's SET NULL.
CREATE INDEX visitor_images_agent_idx ON visitor_images (agent_id) WHERE agent_id IS NOT NULL;

-- A conversation's photos: its erasure, its export, the operator's view, and the cascade.
CREATE INDEX visitor_images_conversation_idx ON visitor_images (conversation_id) WHERE conversation_id IS NOT NULL;

-- The message's SET NULL.
CREATE INDEX visitor_images_message_idx ON visitor_images (message_id) WHERE message_id IS NOT NULL;

-- The unbound sweep: photos no message carries, oldest first.
CREATE INDEX visitor_images_unbound_idx ON visitor_images (created_at) WHERE message_id IS NULL;
