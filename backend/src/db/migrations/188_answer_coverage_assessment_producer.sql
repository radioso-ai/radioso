-- Distinguishes which stage produced an assessment (#1260): the answer
-- envelope's own head, a turn's deterministic zero-evidence fallback, or the
-- shadow assessor kept for the measurement window. Nullable because every row
-- written before this migration has no producer at all.
ALTER TABLE answer_coverage_assessments
  ADD COLUMN producer TEXT CHECK (producer IN ('answer_head', 'deterministic', 'assessor'));
