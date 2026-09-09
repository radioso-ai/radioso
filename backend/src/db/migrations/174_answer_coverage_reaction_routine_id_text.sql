-- Routine definition ids are opaque identifiers. Existing UUID values are preserved as text.
ALTER TABLE answer_coverage_reaction_traces
  ALTER COLUMN routine_id TYPE TEXT USING routine_id::TEXT;
