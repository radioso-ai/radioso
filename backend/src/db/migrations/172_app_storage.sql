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
-- cascades through workspace_id.

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id)
);

-- The retention sweep asks for installations whose deadline has passed and that
-- are not already tombstoned, so the index carries exactly that population.
CREATE INDEX IF NOT EXISTS idx_app_storage_installation_state_retention
  ON app_storage_installation_state (retain_until)
  WHERE retain_until IS NOT NULL AND deleted_at IS NULL;

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

-- A put or a delete reclaims its own collection's expired rows before it decides
-- the quota, so that reclaim is a scoped range scan rather than a table scan.
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
  -- An indexed string is bounded to what the query contract can ask for and what
  -- a B-tree tuple holds. Record validation refuses a longer value first; this is
  -- the backstop that keeps an unqueryable entry out of the table.
  CONSTRAINT app_storage_index_entries_text_bound CHECK (
    text_value IS NULL OR octet_length(text_value) <= 2048
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
-- this row first and record rows second, which is the single order that keeps two
-- of them from waiting on each other.
CREATE TABLE IF NOT EXISTS app_storage_collection_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  collection_id TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  -- The version the next write in this collection takes. It only ever increases,
  -- which is what makes an optimistic version unrepeatable across deletion,
  -- expiry, and recreation.
  next_version BIGINT NOT NULL DEFAULT 1 CHECK (next_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id, collection_id)
);
