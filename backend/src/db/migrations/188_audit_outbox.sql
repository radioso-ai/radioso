-- The platform's one durable audit outbox. A domain that must commit an audit
-- intent in the same transaction as the change it describes enqueues into this
-- table rather than publishing directly; the audit module claims, publishes,
-- and acknowledges it afterwards, outside any transaction the domain held.
--
-- Alone among the tables an ordinary domain owns, workspace_id carries no
-- foreign key. An unpublished entry is the evidence of what happened, and a
-- cascade would erase exactly the entries describing the last thing done to a
-- workspace being torn down. The dispatcher publishes such an entry with a null
-- workspace: audit_events.workspace_id is nullable and its own foreign key sets
-- it to null when the workspace goes, so the entry reaches the trail with its
-- former workspace carried as an identifier in the metadata rather than failing
-- a foreign key on every retry forever.
CREATE TABLE IF NOT EXISTS audit_outbox (
  -- The delivery identity. It reaches the sink on every attempt, so a publish
  -- that succeeded and then failed to be acknowledged is recognisable as the
  -- same event rather than as a second one.
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID,
  -- Null names a host or release-level event rather than one workspace's.
  workspace_id UUID,
  event_type TEXT NOT NULL,
  event_status TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The dispatcher's lease. Rows are claimed in a short transaction that
  -- commits before anything is published, so publication never happens while a
  -- database transaction and its row locks are held. A lease whose deadline
  -- passed is claimable again, which is what retries a publish that failed.
  claim_token UUID,
  claimed_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT audit_outbox_claim CHECK (
    (claim_token IS NULL) = (claimed_until IS NULL)
  )
);

-- The dispatcher claims unleased entries, oldest first. Delivery is
-- at-least-once and ordering is best-effort: created_at is the claiming
-- transaction's own start time, and two claimers using SKIP LOCKED interleave
-- further, so a consumer orders by the event it reads rather than by arrival.
CREATE INDEX IF NOT EXISTS idx_audit_outbox_claimable
  ON audit_outbox (claimed_until, created_at, id);
