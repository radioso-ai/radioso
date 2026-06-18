-- Post-completion mutable slots (issue #746). Marks whether a captured slot value may be
-- corrected after the routine completes. Defaults to false so every existing slot stays
-- immutable until an author opts in.
ALTER TABLE routine_slot
  ADD COLUMN IF NOT EXISTS mutable BOOLEAN NOT NULL DEFAULT false;
