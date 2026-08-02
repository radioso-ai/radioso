-- Durable, continuously maintained content-planning projection. Source wording stays
-- message-owned: projection storage keeps source IDs, non-reversible hashes, vectors,
-- scalar answer evidence, and bounded generated operator prose only.

-- Composite keys let every tenant-owned foreign key prove workspace ownership.
CREATE UNIQUE INDEX idx_conversations_workspace_id_unique
  ON conversations (workspace_id, id);

CREATE UNIQUE INDEX idx_documents_workspace_id_unique
  ON documents (workspace_id, id);

CREATE TABLE content_plan_projection_generations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  embedding_space_id UUID NOT NULL REFERENCES embedding_spaces(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'active', 'reprojection')),
  state TEXT NOT NULL CHECK (state IN ('building', 'coherent', 'superseded', 'failed')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  horizon_from TIMESTAMPTZ NOT NULL,
  horizon_to TIMESTAMPTZ NOT NULL,
  coherent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, embedding_space_id),
  CHECK (horizon_from < horizon_to),
  CHECK (
    (state IN ('coherent', 'superseded') AND coherent_at IS NOT NULL)
    OR (state IN ('building', 'failed') AND coherent_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_content_plan_generations_one_coherent
  ON content_plan_projection_generations (workspace_id)
  WHERE state = 'coherent';

CREATE UNIQUE INDEX idx_content_plan_generations_one_building
  ON content_plan_projection_generations (workspace_id)
  WHERE state = 'building';

CREATE INDEX idx_content_plan_generations_space
  ON content_plan_projection_generations (workspace_id, embedding_space_id, state);

CREATE OR REPLACE FUNCTION reject_content_plan_generation_identity_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.workspace_id,
    NEW.embedding_space_id,
    NEW.kind,
    NEW.policy_version,
    NEW.horizon_from,
    NEW.horizon_to
  ) IS DISTINCT FROM (
    OLD.workspace_id,
    OLD.embedding_space_id,
    OLD.kind,
    OLD.policy_version,
    OLD.horizon_from,
    OLD.horizon_to
  ) THEN
    RAISE EXCEPTION 'content planning generation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_plan_generation_identity_immutable
BEFORE UPDATE ON content_plan_projection_generations
FOR EACH ROW
EXECUTE FUNCTION reject_content_plan_generation_identity_mutation();

CREATE TABLE content_plan_projection_states (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  coherent_generation_id UUID,
  target_generation_id UUID,
  projection_state TEXT NOT NULL
    CHECK (projection_state IN (
      'bootstrapping', 'ready', 'updating', 'delayed', 'reprojecting',
      'degraded', 'budget_paused'
    )),
  reason TEXT CHECK (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  discovery_created_at TIMESTAMPTZ,
  discovery_message_id UUID,
  processed_through TIMESTAMPTZ,
  bootstrap_processed BIGINT,
  bootstrap_total BIGINT,
  budget_version INTEGER NOT NULL CHECK (budget_version > 0),
  budget_window_started_at TIMESTAMPTZ NOT NULL,
  embedding_requests_used INTEGER NOT NULL DEFAULT 0 CHECK (embedding_requests_used >= 0),
  estimated_spend_micros BIGINT NOT NULL DEFAULT 0 CHECK (estimated_spend_micros >= 0),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_plan_state_coherent_generation_fk
    FOREIGN KEY (workspace_id, coherent_generation_id)
    REFERENCES content_plan_projection_generations(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT content_plan_state_target_generation_fk
    FOREIGN KEY (workspace_id, target_generation_id)
    REFERENCES content_plan_projection_generations(workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    coherent_generation_id IS NULL
    OR target_generation_id IS NULL
    OR coherent_generation_id <> target_generation_id
  ),
  CHECK (
    (discovery_created_at IS NULL AND discovery_message_id IS NULL)
    OR (discovery_created_at IS NOT NULL AND discovery_message_id IS NOT NULL)
  ),
  CHECK (
    (bootstrap_processed IS NULL AND bootstrap_total IS NULL)
    OR (
      bootstrap_processed IS NOT NULL
      AND bootstrap_total IS NOT NULL
      AND bootstrap_processed >= 0
      AND bootstrap_total >= 0
      AND bootstrap_processed <= bootstrap_total
    )
  ),
  CHECK (
    (lease_token IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX idx_content_plan_projection_states_work
  ON content_plan_projection_states (projection_state, updated_at)
  WHERE projection_state <> 'ready';

CREATE TABLE content_plan_observations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_user_message_id UUID NOT NULL,
  source_assistant_message_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  semantic_intent_id TEXT NOT NULL,
  semantic_text_hash TEXT,
  interaction_role TEXT NOT NULL
    CHECK (interaction_role IN (
      'substantive_new', 'substantive_followup', 'clarification_value',
      'control', 'social', 'unresolved'
    )),
  grounding_verdict TEXT CHECK (
    grounding_verdict IS NULL
    OR grounding_verdict IN ('grounded', 'degraded', 'no_support')
  ),
  grounding_claim_count INTEGER,
  grounding_sourced_claim_count INTEGER,
  grounding_unsourced_claim_count INTEGER,
  grounding_invalid_source_count INTEGER,
  resolution_deadline TIMESTAMPTZ,
  observation_state TEXT NOT NULL
    CHECK (observation_state IN ('pending_context', 'ready', 'excluded', 'deleted')),
  excluded_reason TEXT
    CHECK (excluded_reason IS NULL OR excluded_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_user_message_id, semantic_intent_id),
  CONSTRAINT content_plan_observations_user_message_fk
    FOREIGN KEY (workspace_id, source_user_message_id)
    REFERENCES messages(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT content_plan_observations_assistant_message_fk
    FOREIGN KEY (workspace_id, source_assistant_message_id)
    REFERENCES messages(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT content_plan_observations_conversation_fk
    FOREIGN KEY (workspace_id, conversation_id)
    REFERENCES conversations(workspace_id, id)
    ON DELETE CASCADE,
  CHECK (
    char_length(semantic_intent_id) BETWEEN 1 AND 128
    AND semantic_intent_id ~ '^[A-Za-z0-9_.:-]+$'
  ),
  CHECK (
    semantic_text_hash IS NULL
    OR semantic_text_hash ~ '^[0-9a-f]{64}$'
  ),
  CHECK (observation_state <> 'ready' OR semantic_text_hash IS NOT NULL),
  CHECK (source_user_message_id <> source_assistant_message_id),
  CHECK (
    (
      grounding_verdict IS NULL
      AND grounding_claim_count IS NULL
      AND grounding_sourced_claim_count IS NULL
      AND grounding_unsourced_claim_count IS NULL
      AND grounding_invalid_source_count IS NULL
    )
    OR (
      grounding_verdict IS NOT NULL
      AND grounding_claim_count IS NOT NULL
      AND grounding_sourced_claim_count IS NOT NULL
      AND grounding_unsourced_claim_count IS NOT NULL
      AND grounding_invalid_source_count IS NOT NULL
    )
  ),
  CHECK (
    grounding_claim_count IS NULL
    OR (
      grounding_claim_count >= 0
      AND grounding_sourced_claim_count >= 0
      AND grounding_unsourced_claim_count >= 0
      AND grounding_invalid_source_count >= 0
      AND grounding_sourced_claim_count + grounding_unsourced_claim_count = grounding_claim_count
    )
  ),
  CHECK (
    (observation_state = 'pending_context' AND resolution_deadline IS NOT NULL)
    OR (observation_state <> 'pending_context' AND resolution_deadline IS NULL)
  ),
  CHECK (
    (observation_state = 'excluded' AND excluded_reason IS NOT NULL)
    OR (observation_state <> 'excluded' AND excluded_reason IS NULL)
  )
);

CREATE INDEX idx_content_plan_observations_workspace_time
  ON content_plan_observations (workspace_id, observed_at DESC, id DESC);

CREATE INDEX idx_content_plan_observations_pending_context
  ON content_plan_observations (workspace_id, resolution_deadline, id)
  WHERE observation_state = 'pending_context';

CREATE TABLE content_plan_observation_vectors (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  embedding_space_id UUID NOT NULL,
  dimensions INTEGER,
  embedding VECTOR,
  vector_source TEXT CHECK (vector_source IS NULL OR vector_source IN ('reused', 'fallback')),
  state TEXT NOT NULL DEFAULT 'pending_embedding'
    CHECK (state IN (
      'pending_embedding', 'ready', 'processing', 'assigned', 'retryable', 'failed'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  claim_expires_at TIMESTAMPTZ,
  failure_stage TEXT
    CHECK (failure_stage IS NULL OR failure_stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_reason TEXT
    CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, observation_id, generation_id),
  CONSTRAINT content_plan_vectors_observation_fk
    FOREIGN KEY (workspace_id, observation_id)
    REFERENCES content_plan_observations(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT content_plan_vectors_generation_space_fk
    FOREIGN KEY (workspace_id, generation_id, embedding_space_id)
    REFERENCES content_plan_projection_generations(workspace_id, id, embedding_space_id)
    ON DELETE CASCADE,
  CHECK (
    (
      embedding IS NULL
      AND dimensions IS NULL
      AND vector_source IS NULL
    )
    OR (
      embedding IS NOT NULL
      AND dimensions BETWEEN 1 AND 16000
      AND vector_source IS NOT NULL
      AND vector_dims(embedding) = dimensions
    )
  ),
  CHECK (state <> 'pending_embedding' OR embedding IS NULL),
  -- A processing lease may cover either fallback embedding (no vector yet) or topic
  -- assignment (vector present). Ready/assigned rows always carry a vector.
  CHECK (state NOT IN ('ready', 'assigned') OR embedding IS NOT NULL),
  CHECK (
    (
      claim_token IS NULL
      AND claimed_at IS NULL
      AND claim_expires_at IS NULL
      AND state <> 'processing'
    )
    OR (
      claim_token IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND state = 'processing'
      AND claim_expires_at > claimed_at
    )
  ),
  CHECK (
    (failure_stage IS NULL AND failure_reason IS NULL AND state NOT IN ('retryable', 'failed'))
    OR (failure_stage IS NOT NULL AND failure_reason IS NOT NULL AND state IN ('retryable', 'failed'))
  ),
  CHECK (
    (state = 'assigned' AND completed_at IS NOT NULL)
    OR (state <> 'assigned' AND completed_at IS NULL)
  )
);

CREATE INDEX idx_content_plan_vectors_claim
  ON content_plan_observation_vectors (state, available_at, workspace_id, generation_id, observation_id)
  WHERE state IN ('pending_embedding', 'ready', 'retryable');

CREATE INDEX idx_content_plan_vectors_workspace_due
  ON content_plan_observation_vectors (workspace_id, available_at, generation_id, observation_id)
  WHERE state IN ('pending_embedding', 'ready', 'retryable');

CREATE INDEX idx_content_plan_vectors_workspace_expired
  ON content_plan_observation_vectors (workspace_id, claim_expires_at, generation_id, observation_id)
  WHERE state = 'processing';

CREATE INDEX idx_content_plan_vectors_generation
  ON content_plan_observation_vectors (workspace_id, generation_id, state);

CREATE TABLE content_plan_topics (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  id UUID NOT NULL,
  embedding_space_id UUID NOT NULL,
  lifecycle TEXT NOT NULL
    CHECK (lifecycle IN ('provisional', 'mature', 'merged', 'retired')),
  centroid VECTOR NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 16000),
  centroid_weight INTEGER NOT NULL CHECK (centroid_weight >= 0),
  representative_observation_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  merged_into_topic_id UUID,
  redirect_expires_at TIMESTAMPTZ,
  enrichment_dirty_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, generation_id, id),
  CONSTRAINT content_plan_topics_generation_space_fk
    FOREIGN KEY (workspace_id, generation_id, embedding_space_id)
    REFERENCES content_plan_projection_generations(workspace_id, id, embedding_space_id)
    ON DELETE CASCADE,
  CHECK (vector_dims(centroid) = dimensions),
  CHECK (
    cardinality(representative_observation_ids) BETWEEN 0 AND 8
    AND array_position(representative_observation_ids, NULL) IS NULL
  ),
  CHECK (
    (
      lifecycle = 'merged'
      AND merged_into_topic_id IS NOT NULL
      AND merged_into_topic_id <> id
      AND redirect_expires_at IS NOT NULL
    )
    OR (
      lifecycle <> 'merged'
      AND merged_into_topic_id IS NULL
      AND redirect_expires_at IS NULL
    )
  ),
  CHECK (
    lifecycle <> 'retired'
    OR (centroid_weight = 0 AND cardinality(representative_observation_ids) = 0)
  ),
  CONSTRAINT content_plan_topics_merge_target_fk
    FOREIGN KEY (workspace_id, generation_id, merged_into_topic_id)
    REFERENCES content_plan_topics(workspace_id, generation_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_content_plan_topics_active
  ON content_plan_topics (workspace_id, generation_id, lifecycle, id)
  WHERE lifecycle IN ('provisional', 'mature');

CREATE INDEX idx_content_plan_topics_enrichment_dirty
  ON content_plan_topics (enrichment_dirty_at, workspace_id, generation_id, id)
  WHERE enrichment_dirty_at IS NOT NULL AND lifecycle = 'mature';

CREATE INDEX idx_content_plan_topics_workspace_dirty
  ON content_plan_topics (workspace_id, generation_id, enrichment_dirty_at, id)
  WHERE enrichment_dirty_at IS NOT NULL AND lifecycle = 'mature';

CREATE TABLE content_plan_topic_memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  observation_id UUID NOT NULL,
  topic_id UUID NOT NULL,
  assignment_version INTEGER NOT NULL CHECK (assignment_version > 0),
  similarity REAL NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  cohesion REAL NOT NULL CHECK (cohesion BETWEEN 0 AND 1),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, generation_id, observation_id),
  CONSTRAINT content_plan_memberships_vector_fk
    FOREIGN KEY (workspace_id, observation_id, generation_id)
    REFERENCES content_plan_observation_vectors(workspace_id, observation_id, generation_id)
    ON DELETE CASCADE,
  CONSTRAINT content_plan_memberships_topic_fk
    FOREIGN KEY (workspace_id, generation_id, topic_id)
    REFERENCES content_plan_topics(workspace_id, generation_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_content_plan_memberships_topic
  ON content_plan_topic_memberships (workspace_id, generation_id, topic_id, observation_id);

CREATE TABLE content_plan_topic_enrichments (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  topic_id UUID NOT NULL,
  source_topic_revision INTEGER NOT NULL CHECK (source_topic_revision > 0),
  source_member_count INTEGER NOT NULL DEFAULT 0 CHECK (source_member_count >= 0),
  source_grounded_count INTEGER NOT NULL DEFAULT 0 CHECK (source_grounded_count >= 0),
  source_degraded_count INTEGER NOT NULL DEFAULT 0 CHECK (source_degraded_count >= 0),
  source_no_support_count INTEGER NOT NULL DEFAULT 0 CHECK (source_no_support_count >= 0),
  source_not_evaluated_count INTEGER NOT NULL DEFAULT 0 CHECK (source_not_evaluated_count >= 0),
  source_credible_opportunity BOOLEAN NOT NULL DEFAULT FALSE,
  source_evidence_strength TEXT NOT NULL DEFAULT 'none'
    CHECK (source_evidence_strength IN ('none', 'low', 'medium', 'high')),
  source_corpus_evidence_fingerprint TEXT CHECK (
    source_corpus_evidence_fingerprint IS NULL
    OR source_corpus_evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  published_source_member_count INTEGER CHECK (published_source_member_count >= 0),
  published_source_grounded_count INTEGER CHECK (published_source_grounded_count >= 0),
  published_source_degraded_count INTEGER CHECK (published_source_degraded_count >= 0),
  published_source_no_support_count INTEGER CHECK (published_source_no_support_count >= 0),
  published_source_not_evaluated_count INTEGER CHECK (published_source_not_evaluated_count >= 0),
  published_source_credible_opportunity BOOLEAN,
  published_source_evidence_strength TEXT CHECK (
    published_source_evidence_strength IS NULL
    OR published_source_evidence_strength IN ('none', 'low', 'medium', 'high')
  ),
  published_source_corpus_evidence_fingerprint TEXT CHECK (
    published_source_corpus_evidence_fingerprint IS NULL
    OR published_source_corpus_evidence_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  analysis_mode TEXT NOT NULL DEFAULT 'label_and_brief'
    CHECK (analysis_mode IN ('label_and_brief', 'label_only')),
  publish_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (publish_state IN ('ready', 'outside_analysis_cap')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'ready', 'stale', 'unavailable', 'outside_analysis_cap')),
  label TEXT CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 1 AND 500),
  suggested_title TEXT
    CHECK (suggested_title IS NULL OR char_length(suggested_title) BETWEEN 1 AND 200),
  rationale TEXT CHECK (rationale IS NULL OR char_length(rationale) BETWEEN 1 AND 1000),
  questions_to_answer JSONB CHECK (
    questions_to_answer IS NULL
    OR (
      jsonb_typeof(questions_to_answer) = 'array'
      AND jsonb_array_length(questions_to_answer) BETWEEN 3 AND 7
    )
  ),
  suggested_shape TEXT CHECK (
    suggested_shape IS NULL
    OR suggested_shape IN ('guide', 'faq', 'reference', 'policy', 'troubleshooting')
  ),
  evidence_statement TEXT
    CHECK (evidence_statement IS NULL OR char_length(evidence_statement) BETWEEN 1 AND 500),
  action TEXT CHECK (
    action IS NULL
    OR action IN ('add_content', 'review_existing_content', 'investigate_retrieval', 'monitor')
  ),
  action_rule_version INTEGER NOT NULL CHECK (action_rule_version > 0),
  corpus_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (corpus_state IN ('pending', 'ready', 'unavailable', 'stale')),
  corpus_checked_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_token UUID,
  claim_expires_at TIMESTAMPTZ,
  failure_stage TEXT
    CHECK (failure_stage IS NULL OR failure_stage ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_reason TEXT
    CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  enriched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, generation_id, topic_id),
  CONSTRAINT content_plan_enrichments_topic_fk
    FOREIGN KEY (workspace_id, generation_id, topic_id)
    REFERENCES content_plan_topics(workspace_id, generation_id, id)
    ON DELETE CASCADE,
  CHECK (
    (claim_token IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  CHECK (
    source_grounded_count + source_degraded_count + source_no_support_count
      + source_not_evaluated_count = source_member_count
  ),
  CHECK (
    (
      published_source_member_count IS NULL
      AND published_source_grounded_count IS NULL
      AND published_source_degraded_count IS NULL
      AND published_source_no_support_count IS NULL
      AND published_source_not_evaluated_count IS NULL
      AND published_source_credible_opportunity IS NULL
      AND published_source_evidence_strength IS NULL
    )
    OR (
      published_source_member_count IS NOT NULL
      AND published_source_grounded_count IS NOT NULL
      AND published_source_degraded_count IS NOT NULL
      AND published_source_no_support_count IS NOT NULL
      AND published_source_not_evaluated_count IS NOT NULL
      AND published_source_credible_opportunity IS NOT NULL
      AND published_source_evidence_strength IS NOT NULL
      AND published_source_grounded_count + published_source_degraded_count
        + published_source_no_support_count + published_source_not_evaluated_count
        = published_source_member_count
    )
  ),
  CHECK (
    (failure_stage IS NULL AND failure_reason IS NULL)
    OR (failure_stage IS NOT NULL AND failure_reason IS NOT NULL)
  ),
  CHECK (state <> 'ready' OR (label IS NOT NULL AND description IS NOT NULL AND enriched_at IS NOT NULL)),
  CHECK (
    action NOT IN ('add_content', 'review_existing_content', 'investigate_retrieval')
    OR corpus_state = 'ready'
  ),
  CHECK (corpus_state <> 'unavailable' OR action IS NULL)
);

CREATE INDEX idx_content_plan_enrichments_claim
  ON content_plan_topic_enrichments (available_at, workspace_id, generation_id, topic_id)
  WHERE state IN ('pending', 'stale');

CREATE INDEX idx_content_plan_enrichments_workspace_due
  ON content_plan_topic_enrichments (workspace_id, available_at, generation_id, topic_id)
  WHERE state IN ('pending', 'stale');

CREATE OR REPLACE FUNCTION validate_content_plan_enrichment_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision INTEGER;
BEGIN
  IF NEW.state <> 'ready' THEN
    RETURN NEW;
  END IF;

  SELECT revision
  INTO current_revision
  FROM content_plan_topics
  WHERE workspace_id = NEW.workspace_id
    AND generation_id = NEW.generation_id
    AND id = NEW.topic_id;

  IF current_revision IS NULL OR current_revision <> NEW.source_topic_revision THEN
    RAISE EXCEPTION 'stale content planning enrichment revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_plan_enrichment_revision_fence
BEFORE INSERT OR UPDATE ON content_plan_topic_enrichments
FOR EACH ROW
EXECUTE FUNCTION validate_content_plan_enrichment_revision();

CREATE OR REPLACE FUNCTION stale_content_plan_enrichment_on_topic_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision IS DISTINCT FROM OLD.revision THEN
    UPDATE content_plan_topic_enrichments
    SET
      -- Every aggregate revision fences stale in-flight output. Only a scheduler-owned
      -- material dirty-time change makes the last coherent published evidence stale.
      state = CASE
        WHEN NEW.enrichment_dirty_at IS DISTINCT FROM OLD.enrichment_dirty_at AND state = 'ready'
          THEN 'stale'
        ELSE state
      END,
      corpus_state = CASE
        WHEN NEW.enrichment_dirty_at IS DISTINCT FROM OLD.enrichment_dirty_at AND corpus_state = 'ready'
          THEN 'stale'
        ELSE corpus_state
      END,
      claim_token = NULL,
      claim_expires_at = NULL,
      updated_at = NOW()
    WHERE workspace_id = NEW.workspace_id
      AND generation_id = NEW.generation_id
      AND topic_id = NEW.id
      AND source_topic_revision <> NEW.revision;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_plan_topic_revision_stales_enrichment
AFTER UPDATE OF revision ON content_plan_topics
FOR EACH ROW
EXECUTE FUNCTION stale_content_plan_enrichment_on_topic_revision();

CREATE TABLE content_plan_topic_documents (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  generation_id UUID NOT NULL,
  topic_id UUID NOT NULL,
  document_id UUID NOT NULL,
  source_topic_revision INTEGER NOT NULL CHECK (source_topic_revision > 0),
  similarity REAL NOT NULL CHECK (similarity BETWEEN 0 AND 1),
  existed_before_gap BOOLEAN NOT NULL DEFAULT FALSE,
  retrieved_by_gap_answers BOOLEAN NOT NULL DEFAULT FALSE,
  cited_by_gap_answers BOOLEAN NOT NULL DEFAULT FALSE,
  changed_after_gap BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, generation_id, topic_id, document_id),
  CONSTRAINT content_plan_topic_documents_topic_fk
    FOREIGN KEY (workspace_id, generation_id, topic_id)
    REFERENCES content_plan_topics(workspace_id, generation_id, id)
    ON DELETE CASCADE,
  CONSTRAINT content_plan_topic_documents_document_fk
    FOREIGN KEY (workspace_id, document_id)
    REFERENCES documents(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX idx_content_plan_topic_documents_document
  ON content_plan_topic_documents (workspace_id, document_id, generation_id, topic_id);

CREATE OR REPLACE FUNCTION validate_content_plan_topic_document_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision INTEGER;
BEGIN
  SELECT revision
  INTO current_revision
  FROM content_plan_topics
  WHERE workspace_id = NEW.workspace_id
    AND generation_id = NEW.generation_id
    AND id = NEW.topic_id;

  IF current_revision IS NULL OR current_revision <> NEW.source_topic_revision THEN
    RAISE EXCEPTION 'stale content planning topic-document revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_plan_topic_document_revision_fence
BEFORE INSERT OR UPDATE ON content_plan_topic_documents
FOR EACH ROW
EXECUTE FUNCTION validate_content_plan_topic_document_revision();

CREATE OR REPLACE FUNCTION enforce_content_plan_topic_document_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  related_document_count INTEGER;
BEGIN
  -- Lock the owning topic so concurrent insertions cannot both pass the five-row cap.
  PERFORM 1
  FROM content_plan_topics
  WHERE workspace_id = NEW.workspace_id
    AND generation_id = NEW.generation_id
    AND id = NEW.topic_id
  FOR UPDATE;

  SELECT count(*)
  INTO related_document_count
  FROM content_plan_topic_documents
  WHERE workspace_id = NEW.workspace_id
    AND generation_id = NEW.generation_id
    AND topic_id = NEW.topic_id;

  IF related_document_count >= 5 THEN
    RAISE EXCEPTION 'content planning topics retain at most five related documents'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER content_plan_topic_document_limit
BEFORE INSERT ON content_plan_topic_documents
FOR EACH ROW
EXECUTE FUNCTION enforce_content_plan_topic_document_limit();
