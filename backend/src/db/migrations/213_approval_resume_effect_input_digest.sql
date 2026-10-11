ALTER TABLE approval_resume_effects
  ADD COLUMN input_digest TEXT NOT NULL DEFAULT '';

ALTER TABLE approval_resume_effects
  DROP CONSTRAINT approval_resume_effects_pkey;

ALTER TABLE approval_resume_effects
  ADD PRIMARY KEY (pending_decision_id, routine_id, step_id, occurrence_ordinal, input_digest);
