-- A resume may call an external skill before the decision transaction commits. These rows are
-- written through an autonomous connection, so a later rollback leaves a durable replay record.
CREATE TABLE approval_resume_effect_decisions (
  pending_decision_id UUID PRIMARY KEY REFERENCES pending_decisions(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE approval_resume_effects (
  pending_decision_id UUID NOT NULL REFERENCES approval_resume_effect_decisions(pending_decision_id) ON DELETE CASCADE,
  routine_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  occurrence_ordinal INTEGER NOT NULL CHECK (occurrence_ordinal > 0),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed')),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (pending_decision_id, routine_id, step_id, occurrence_ordinal),
  CHECK ((status = 'started' AND result IS NULL AND completed_at IS NULL)
    OR (status = 'completed' AND result IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE INDEX approval_resume_effect_decisions_created_at_idx
  ON approval_resume_effect_decisions (created_at);
