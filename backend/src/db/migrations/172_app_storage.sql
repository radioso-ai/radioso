-- Managed App Storage. Apps declare logical collections in their manifest; the
-- physical model here is Radioso-owned and generic, so installing or updating an
-- App never runs App-specific DDL and an App can never observe these tables.
--
-- Every row is keyed by (workspace_id, installation_id) first, and every query
-- the repository issues supplies both. Isolation is that scoped predicate plus
-- the installation state row each operation locks and rechecks; the primary key
-- makes the scoped lookup cheap and unique, it does not by itself keep an
-- unscoped query from reading another installation's rows.
--
-- installation_id has no foreign key yet. The `apps` domain that owns the
-- installation row lands beside this one; until it does, an installation's rows
-- are removed explicitly by the disposition path, and workspace deletion
-- cascades through workspace_id: every table holding data carries workspace_id
-- with an ON DELETE CASCADE reference, or hangs off one that does. The audit
-- outbox is the deliberate exception, for the reason stated above it.
--
-- One lock order holds across every statement any of these tables sees:
-- installation state row, then the collection's counter row, then record rows.
-- A sweep, a put, a delete, a rebuild, and an installation deletion all approach
-- from that side, so none of them waits on a lock another already holds in the
-- opposite order.

-- The row every storage operation locks before it does anything else. Revocation,
-- retention, and deletion all move this row, so a runtime operation that holds it
-- cannot commit across a disposition that decided it should not.
CREATE TABLE IF NOT EXISTS app_storage_installation_state (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  -- Disable and quarantine revoke storage access without deleting a record.
  access_revoked_at TIMESTAMPTZ,
  -- The deadline an operator chose when removal retained the data instead of
  -- exporting or deleting it.
  retain_until TIMESTAMPTZ,
  -- The tombstone installation deletion leaves. It outlives the rows it removed,
  -- so an operation admitted before the deletion cannot recreate them afterwards;
  -- only workspace deletion takes the row itself.
  deleted_at TIMESTAMPTZ,
  -- What the deletion removed, kept on the tombstone so a retried deletion
  -- answers with the counts the committed one did rather than refusing.
  deleted_record_count INTEGER,
  deleted_collection_count INTEGER,
  -- Indexes a rebuild is currently building, as
  -- {"<collection_id>": [{"id","field","fieldType","generation","finishedAt","leaseUntil"}]}.
  -- A put maintains entries for these as well as for the indexes its own release
  -- declares, so a rebuild running beside an older release's writes converges
  -- instead of losing the keys those writes touched. The generation is the
  -- rebuild's own identity: finishing and cancelling are compare-and-set against
  -- it, so one run can never clear the marker another run is still scanning
  -- under. `leaseUntil` is how long a marker survives without a sign of life:
  -- every batch renews it, converging renews it once more for the activation to
  -- come, and a marker past its deadline belongs to a run that died.
  pending_indexes JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Hands out the generation each rebuild is identified by. It only increases, so
  -- a generation names one rebuild of one index for the life of the installation.
  -- The ceiling is JavaScript's safe-integer maximum, like next_version below: a
  -- generation is carried as a JSON number and pasted into a completion token, so
  -- past that point two rebuilds would compare equal and a stale token could
  -- clear a live one.
  rebuild_generation BIGINT NOT NULL DEFAULT 0
    CHECK (rebuild_generation >= 0 AND rebuild_generation <= 9007199254740991),
  -- The soonest deadline any marker in pending_indexes holds, derived from them
  -- on every write. It exists so the sweep that drops abandoned rebuilds finds
  -- its work with a range scan instead of reading every installation's JSON; the
  -- per-marker deadlines are what the drop itself is decided by, under this row's
  -- own lock.
  rebuild_lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id)
);

-- The retention sweep asks for installations whose deadline has passed and that
-- are not already tombstoned, so the index carries exactly that population.
CREATE INDEX IF NOT EXISTS idx_app_storage_installation_state_retention
  ON app_storage_installation_state (retain_until)
  WHERE retain_until IS NOT NULL AND deleted_at IS NULL;

-- The rebuild sweep asks for installations holding a marker whose lease has run
-- out and that are not already tombstoned.
CREATE INDEX IF NOT EXISTS idx_app_storage_installation_state_rebuild_lease
  ON app_storage_installation_state (rebuild_lease_until)
  WHERE rebuild_lease_until IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app_storage_records (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  collection_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  -- The collection schema version the writing release declared.
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  value JSONB NOT NULL,
  -- Serialized size of value, measured once at write time so quota accounting
  -- never re-serializes a stored record.
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  -- Taken from the collection's next_version counter, never derived from the row
  -- being replaced. A version is therefore monotonic per collection and is never
  -- reused, so a record deleted and recreated under the same key cannot make a
  -- stale expectedVersion match again.
  version BIGINT NOT NULL CHECK (version > 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id, collection_id, record_key)
);

-- The sweeper looks for expired rows across every installation.
CREATE INDEX IF NOT EXISTS idx_app_storage_records_expiry
  ON app_storage_records (expires_at)
  WHERE expires_at IS NOT NULL;

-- A put reclaims a bounded batch of its own collection's expired rows before it
-- decides the quota, so that reclaim is a scoped range scan rather than a table
-- scan.
CREATE INDEX IF NOT EXISTS idx_app_storage_records_collection_expiry
  ON app_storage_records (workspace_id, installation_id, collection_id, expires_at)
  WHERE expires_at IS NOT NULL;

-- One row per declared index per record. A scalar is stored in the column of its
-- declared type rather than as text, so an equality comparison uses the type's
-- own ordering and a numeric index never compares "10" against "9" as strings.
CREATE TABLE IF NOT EXISTS app_storage_index_entries (
  workspace_id UUID NOT NULL,
  installation_id UUID NOT NULL,
  collection_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  index_id TEXT NOT NULL,
  text_value TEXT,
  numeric_value DOUBLE PRECISION,
  boolean_value BOOLEAN,
  timestamp_value TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, installation_id, collection_id, record_key, index_id),
  CONSTRAINT app_storage_index_entries_one_value CHECK (
    (text_value IS NOT NULL)::int
    + (numeric_value IS NOT NULL)::int
    + (boolean_value IS NOT NULL)::int
    + (timestamp_value IS NOT NULL)::int = 1
  ),
  -- An indexed string is bounded by what the whole B-tree tuple holds, not by the
  -- value alone: a page admits roughly 2704 bytes per index tuple, and the entry
  -- also carries two uuids, a collection id, an index id, and a record key, whose
  -- contract maxima leave 1464 bytes for the value. Record validation refuses a
  -- longer value first and a rebuild reports one it finds already stored; this is
  -- the backstop that keeps an entry the index cannot hold out of the table.
  CONSTRAINT app_storage_index_entries_text_bound CHECK (
    text_value IS NULL OR octet_length(text_value) <= 1464
  ),
  FOREIGN KEY (workspace_id, installation_id, collection_id, record_key)
    REFERENCES app_storage_records (workspace_id, installation_id, collection_id, record_key)
    ON DELETE CASCADE
);

-- query_by_index is equality on one declared index, paginated by record_key, so
-- each index carries the key as its trailing column and the page is an index-only
-- range scan rather than a sort.
CREATE INDEX IF NOT EXISTS idx_app_storage_index_entries_text
  ON app_storage_index_entries (workspace_id, installation_id, collection_id, index_id, text_value, record_key)
  WHERE text_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_storage_index_entries_numeric
  ON app_storage_index_entries (workspace_id, installation_id, collection_id, index_id, numeric_value, record_key)
  WHERE numeric_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_storage_index_entries_boolean
  ON app_storage_index_entries (workspace_id, installation_id, collection_id, index_id, boolean_value, record_key)
  WHERE boolean_value IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_storage_index_entries_timestamp
  ON app_storage_index_entries (workspace_id, installation_id, collection_id, index_id, timestamp_value, record_key)
  WHERE timestamp_value IS NOT NULL;

-- A maintained counter rather than a COUNT over the records table. A quota check
-- runs on the write path of every put, and a counter row the write already locks
-- answers it in constant time; counting instead would make the cost of admitting
-- a record grow with the number of records already admitted.
--
-- It is also the collection's lock: every put, delete, reclaim, and rebuild takes
-- the installation state row first, this row second, and record rows third, which
-- is the single order that keeps two of them from waiting on each other.
CREATE TABLE IF NOT EXISTS app_storage_collection_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  collection_id TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  -- The version the next write in this collection takes. It only ever increases,
  -- which is what makes an optimistic version unrepeatable across deletion,
  -- expiry, and recreation. The ceiling is JavaScript's safe-integer maximum: a
  -- version crosses the wire as a JSON number, and past that point two versions
  -- would round to one value, so the counter stops rather than repeat itself.
  next_version BIGINT NOT NULL DEFAULT 1
    CHECK (next_version > 0 AND next_version <= 9007199254740991),
  -- When the expiry sweep last worked this collection. The sweep claims the
  -- least recently swept collections first, so a busy collection cannot be
  -- picked over and over while another keeps its expired rows.
  last_swept_at TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
  -- The sweep's durable claim on this collection. A claim commits before the
  -- reclamation it authorises runs, so `SKIP LOCKED` alone would let a second
  -- worker take the same collection the moment the first one committed. The
  -- lease is what carries the claim past that commit; a lease whose deadline has
  -- passed is reclaimable, so a worker that died holds nothing forever.
  sweep_lease_token UUID,
  sweep_lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id, collection_id),
  -- A lease is a token and a deadline together; neither half means anything alone.
  CONSTRAINT app_storage_collection_usage_lease CHECK (
    (sweep_lease_token IS NULL) = (sweep_lease_until IS NULL)
  )
);

-- The sweep's discovery orders by this column, so it carries the fairness cursor.
CREATE INDEX IF NOT EXISTS idx_app_storage_collection_usage_sweep
  ON app_storage_collection_usage (last_swept_at);

-- An irreversible disposition and the audit event that describes it commit in one
-- transaction, which is what keeps the trail from disagreeing with the data: a
-- deletion that committed always has its event, and an event never describes a
-- deletion that rolled back. Publishing is the drain's job afterwards, so a
-- failure to publish costs a retry rather than the record of what happened.
--
-- This is storage's own outbox. The `apps` domain has one for its lifecycle
-- events, and the two may unify once both sides have settled.
--
-- Alone among these tables, workspace_id carries no foreign key. Every other row
-- here is the data itself and goes with the workspace; an undrained disposition
-- event is the evidence that the data was exported, retained, or deleted, and a
-- cascade would erase exactly the entries describing the last thing that happened
-- to a workspace being torn down. The drain publishes such an entry with a null
-- workspace: audit_events.workspace_id is nullable and its own foreign key sets
-- it to null when the workspace goes, so the entry reaches the trail with its
-- former workspace carried as an identifier in the metadata rather than failing
-- a foreign key on every retry forever.
CREATE TABLE IF NOT EXISTS app_storage_audit_outbox (
  -- The delivery identity. It reaches the sink on every attempt, so a publish
  -- that succeeded and then failed to be acknowledged is recognisable as the
  -- same event rather than as a second one.
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  installation_id UUID,
  event_type TEXT NOT NULL,
  event_status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The drain's lease. Rows are claimed in a short transaction that commits
  -- before anything is published, so publication never happens while a database
  -- transaction and its row locks are held. A lease whose deadline passed is
  -- claimable again, which is what retries a publish that failed.
  claim_token UUID,
  claimed_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT app_storage_audit_outbox_claim CHECK (
    (claim_token IS NULL) = (claimed_until IS NULL)
  )
);

-- The drain claims unleased entries, oldest first. Delivery is at-least-once and
-- ordering is best-effort: created_at is the claiming transaction's own start
-- time, and two drainers using SKIP LOCKED interleave further, so a consumer
-- orders by the event it reads rather than by arrival.
CREATE INDEX IF NOT EXISTS idx_app_storage_audit_outbox_claimable
  ON app_storage_audit_outbox (claimed_until, created_at, id);
