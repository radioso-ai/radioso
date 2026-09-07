-- Managed App Storage. Apps declare logical collections in their manifest; the
-- physical model here is Radioso-owned and generic, so installing or updating an
-- App never runs App-specific DDL and an App can never observe these tables.
--
-- Every row is keyed by (workspace_id, installation_id) first. Isolation is the
-- primary key, not a filter a query may forget: a record under one installation
-- is unreachable from another even when the collection and key match.
--
-- installation_id has no foreign key yet. The `apps` domain that owns the
-- installation row lands beside this one; until it does, an installation's rows
-- are removed explicitly by the disposition path, and workspace deletion
-- cascades through workspace_id.

CREATE TABLE IF NOT EXISTS app_storage_installation_state (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  -- Disable and quarantine revoke storage access without deleting a record.
  access_revoked_at TIMESTAMPTZ,
  -- The deadline an operator chose when removal retained the data instead of
  -- exporting or deleting it.
  retain_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_app_storage_installation_state_retention
  ON app_storage_installation_state (retain_until)
  WHERE retain_until IS NOT NULL;

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
  version INTEGER NOT NULL CHECK (version > 0),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id, collection_id, record_key)
);

CREATE INDEX IF NOT EXISTS idx_app_storage_records_expiry
  ON app_storage_records (expires_at)
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
CREATE TABLE IF NOT EXISTS app_storage_collection_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL,
  collection_id TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, installation_id, collection_id)
);
