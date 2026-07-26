CREATE TABLE embedding_spaces (
  id UUID PRIMARY KEY,
  identity_fingerprint TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  endpoint_scope_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
  normalization TEXT NOT NULL,
  document_task TEXT,
  query_task TEXT,
  vector_options JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'quarantined')),
  quarantine_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'active' AND quarantine_reason IS NULL)
    OR (status = 'quarantined' AND quarantine_reason IS NOT NULL)
  )
);

CREATE FUNCTION reject_embedding_space_identity_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.identity_fingerprint,
    NEW.provider,
    NEW.endpoint_scope_fingerprint,
    NEW.model,
    NEW.dimensions,
    NEW.distance_metric,
    NEW.normalization,
    NEW.document_task,
    NEW.query_task,
    NEW.vector_options,
    NEW.model_version
  ) IS DISTINCT FROM (
    OLD.identity_fingerprint,
    OLD.provider,
    OLD.endpoint_scope_fingerprint,
    OLD.model,
    OLD.dimensions,
    OLD.distance_metric,
    OLD.normalization,
    OLD.document_task,
    OLD.query_task,
    OLD.vector_options,
    OLD.model_version
  ) THEN
    RAISE EXCEPTION 'embedding space identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER embedding_spaces_identity_immutable
BEFORE UPDATE ON embedding_spaces
FOR EACH ROW
EXECUTE FUNCTION reject_embedding_space_identity_mutation();

CREATE TABLE workspace_embedding_profiles (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  active_embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  pending_embedding_space_id UUID REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    pending_embedding_space_id IS NULL
    OR pending_embedding_space_id <> active_embedding_space_id
  )
);

CREATE INDEX idx_workspace_embedding_profiles_active_space
  ON workspace_embedding_profiles (active_embedding_space_id);

CREATE INDEX idx_workspace_embedding_profiles_pending_space
  ON workspace_embedding_profiles (pending_embedding_space_id)
  WHERE pending_embedding_space_id IS NOT NULL;

CREATE TABLE workspace_embedding_transitions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  target_embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  generation BIGINT NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL
    CHECK (status IN ('building', 'blocked', 'quarantined', 'cancelled', 'promoted', 'failed')),
  failure_reason TEXT,
  cleanup_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  CHECK (source_embedding_space_id <> target_embedding_space_id),
  CHECK (
    (status IN ('blocked', 'quarantined', 'failed') AND failure_reason IS NOT NULL)
    OR (status NOT IN ('blocked', 'quarantined', 'failed'))
  ),
  CHECK (
    (status IN ('cancelled', 'promoted', 'failed') AND completed_at IS NOT NULL)
    OR (status NOT IN ('cancelled', 'promoted', 'failed'))
  )
);

CREATE UNIQUE INDEX idx_workspace_embedding_transitions_one_live
  ON workspace_embedding_transitions (workspace_id)
  WHERE status IN ('building', 'blocked', 'quarantined');

CREATE INDEX idx_workspace_embedding_transitions_target
  ON workspace_embedding_transitions (workspace_id, target_embedding_space_id);

CREATE TABLE chunk_embeddings (
  workspace_id UUID NOT NULL,
  chunk_id UUID NOT NULL,
  embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  document_revision INTEGER NOT NULL CHECK (document_revision >= 1),
  canonical_version BIGINT NOT NULL CHECK (canonical_version >= 1),
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  embedding VECTOR NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, chunk_id, embedding_space_id),
  FOREIGN KEY (workspace_id, chunk_id)
    REFERENCES chunks(workspace_id, id)
    ON DELETE CASCADE,
  CHECK (vector_dims(embedding) = dimensions)
);

CREATE INDEX idx_chunk_embeddings_space
  ON chunk_embeddings (workspace_id, embedding_space_id);

CREATE INDEX idx_chunk_embeddings_chunk
  ON chunk_embeddings (workspace_id, chunk_id);

ALTER TABLE document_processing_jobs
  ADD COLUMN embedding_space_id UUID REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  ADD COLUMN workspace_profile_generation BIGINT CHECK (workspace_profile_generation >= 1);

ALTER TABLE document_processing_jobs
  DROP CONSTRAINT document_processing_jobs_document_id_document_revision_kind_key;

CREATE UNIQUE INDEX idx_document_processing_jobs_revision_phase
  ON document_processing_jobs (document_id, document_revision, kind)
  WHERE kind <> 'embedding_profile';

CREATE UNIQUE INDEX idx_document_processing_jobs_embedding_profile
  ON document_processing_jobs (
    document_id,
    document_revision,
    kind,
    embedding_space_id,
    workspace_profile_generation
  )
  WHERE kind = 'embedding_profile';

ALTER TABLE document_processing_jobs
  ADD CONSTRAINT document_processing_jobs_embedding_profile_fence_check
  CHECK (
    (
      kind = 'embedding_profile'
      AND embedding_space_id IS NOT NULL
      AND workspace_profile_generation IS NOT NULL
    )
    OR (
      kind <> 'embedding_profile'
      AND embedding_space_id IS NULL
      AND workspace_profile_generation IS NULL
    )
  );

CREATE TABLE vector_index_work (
  sequence BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  chunk_id UUID NOT NULL,
  document_id UUID,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'filter_update')),
  canonical_version BIGINT NOT NULL CHECK (canonical_version >= 1),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (
    workspace_id,
    embedding_space_id,
    chunk_id,
    canonical_version,
    operation
  )
);

CREATE INDEX idx_vector_index_work_claim
  ON vector_index_work (status, available_at, sequence);

CREATE INDEX idx_vector_index_work_chunk_version
  ON vector_index_work (
    workspace_id,
    embedding_space_id,
    chunk_id,
    canonical_version DESC
  );

CREATE TABLE vector_index_checkpoints (
  backend_key TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  acknowledged_sequence BIGINT NOT NULL DEFAULT 0 CHECK (acknowledged_sequence >= 0),
  readiness TEXT NOT NULL DEFAULT 'building'
    CHECK (readiness IN ('building', 'ready', 'stale', 'unavailable', 'exact_fallback')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (backend_key, workspace_id, embedding_space_id)
);

CREATE INDEX idx_vector_index_checkpoints_space
  ON vector_index_checkpoints (workspace_id, embedding_space_id);
