-- Structured, concurrency-safe Quality triage and the stable identity that
-- connects one assistant message to its current Eval case.

ALTER TABLE assistant_answer_triage
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN resolution_reason TEXT,
  ADD COLUMN resolution_note TEXT,
  ADD COLUMN closed_at TIMESTAMPTZ;

UPDATE assistant_answer_triage
SET closed_at = updated_at
WHERE state IN ('resolved', 'dismissed')
  AND closed_at IS NULL;

ALTER TABLE assistant_answer_triage
  ADD CONSTRAINT assistant_answer_triage_version_check
    CHECK (version > 0),
  ADD CONSTRAINT assistant_answer_triage_resolution_reason_check
    CHECK (
      resolution_reason IS NULL
      OR resolution_reason IN (
        'knowledge_gap',
        'retrieval_issue',
        'agent_behavior',
        'platform_bug',
        'expected_behavior',
        'out_of_scope',
        'invalid_feedback',
        'other'
      )
    ),
  ADD CONSTRAINT assistant_answer_triage_resolution_state_check
    CHECK (
      (state = 'resolved' AND (
        resolution_reason IS NULL
        OR resolution_reason IN (
          'knowledge_gap',
          'retrieval_issue',
          'agent_behavior',
          'platform_bug',
          'other'
        )
      ))
      OR
      (state = 'dismissed' AND (
        resolution_reason IS NULL
        OR resolution_reason IN (
          'expected_behavior',
          'out_of_scope',
          'invalid_feedback',
          'other'
        )
      ))
      OR
      (state IN ('open', 'acknowledged')
        AND resolution_reason IS NULL
        AND resolution_note IS NULL)
    ),
  ADD CONSTRAINT assistant_answer_triage_resolution_note_check
    CHECK (
      resolution_note IS NULL
      OR (
        resolution_reason IS NOT NULL
        AND char_length(resolution_note) BETWEEN 1 AND 500
      )
    ),
  ADD CONSTRAINT assistant_answer_triage_other_note_check
    CHECK (
      resolution_reason <> 'other'
      OR (
        resolution_note IS NOT NULL
        AND char_length(btrim(resolution_note)) > 0
      )
    ),
  ADD CONSTRAINT assistant_answer_triage_closed_at_check
    CHECK (
      (state IN ('resolved', 'dismissed') AND closed_at IS NOT NULL)
      OR
      (state IN ('open', 'acknowledged') AND closed_at IS NULL)
    );

CREATE INDEX idx_assistant_answer_triage_workspace_closed
  ON assistant_answer_triage (workspace_id, state, closed_at DESC)
  WHERE state IN ('resolved', 'dismissed');

CREATE INDEX idx_assistant_answer_triage_workspace_resolution
  ON assistant_answer_triage (workspace_id, state, resolution_reason, closed_at DESC)
  WHERE state IN ('resolved', 'dismissed');

-- These composite unique indexes let association and transition foreign keys
-- prove that the referenced entity belongs to the same workspace.
CREATE UNIQUE INDEX idx_messages_workspace_id_unique
  ON messages (workspace_id, id);

CREATE UNIQUE INDEX idx_eval_cases_workspace_id_unique
  ON eval_cases (workspace_id, id);

CREATE TABLE assistant_answer_triage_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL,
  prior_state TEXT NOT NULL,
  next_state TEXT NOT NULL,
  resulting_version INTEGER NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  resolution_reason TEXT,
  linked_eval_case_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_answer_triage_transitions_message_fk
    FOREIGN KEY (workspace_id, assistant_message_id)
    REFERENCES messages(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT assistant_answer_triage_transitions_prior_state_check
    CHECK (prior_state IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  CONSTRAINT assistant_answer_triage_transitions_next_state_check
    CHECK (next_state IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  CONSTRAINT assistant_answer_triage_transitions_version_check
    CHECK (resulting_version > 0),
  CONSTRAINT assistant_answer_triage_transitions_reason_check
    CHECK (
      resolution_reason IS NULL
      OR resolution_reason IN (
        'knowledge_gap',
        'retrieval_issue',
        'agent_behavior',
        'platform_bug',
        'expected_behavior',
        'out_of_scope',
        'invalid_feedback',
        'other'
      )
    ),
  UNIQUE (workspace_id, assistant_message_id, resulting_version)
);

CREATE INDEX idx_assistant_answer_triage_transitions_workspace_created
  ON assistant_answer_triage_transitions (workspace_id, created_at DESC);

CREATE TABLE eval_message_case_associations (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assistant_message_id UUID NOT NULL,
  case_id UUID NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, assistant_message_id),
  CONSTRAINT eval_message_case_associations_message_fk
    FOREIGN KEY (workspace_id, assistant_message_id)
    REFERENCES messages(workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT eval_message_case_associations_case_fk
    FOREIGN KEY (workspace_id, case_id)
    REFERENCES eval_cases(workspace_id, id)
    ON DELETE CASCADE,
  UNIQUE (case_id)
);

CREATE INDEX idx_eval_message_case_associations_workspace_case
  ON eval_message_case_associations (workspace_id, case_id);

-- Preserve the implicit message/case relationship used by the pre-feature
-- client scan. A message may have been captured into several cases; the newest
-- current case wins deterministically, while immutable snapshots remain
-- independently recapturable.
WITH ranked_existing_cases AS (
  SELECT
    c.workspace_id,
    s.source_message_id AS assistant_message_id,
    c.id AS case_id,
    c.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY c.workspace_id, s.source_message_id
      ORDER BY c.updated_at DESC, c.id DESC
    ) AS message_rank
  FROM eval_cases c
  JOIN eval_snapshots s
    ON s.id = c.snapshot_id
   AND s.workspace_id = c.workspace_id
  JOIN messages m
    ON m.id = s.source_message_id
   AND m.workspace_id = c.workspace_id
  WHERE s.source_message_id IS NOT NULL
    AND m.role = 'assistant'
)
INSERT INTO eval_message_case_associations (
  workspace_id,
  assistant_message_id,
  case_id,
  created_at
)
SELECT
  workspace_id,
  assistant_message_id,
  case_id,
  created_at
FROM ranked_existing_cases
WHERE message_rank = 1;
