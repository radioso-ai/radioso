-- How many times in a row the routine's current step has been asked again without the visitor
-- filling any slot it collects (#1376). The runner resets it when the routine enters a step or a
-- turn fills one of the step's slots, and past its re-ask limit takes the step's hand-off exit or
-- asks differently. Rows written before this column existed start at 0: an in-flight step gets the
-- full limit from here on.
ALTER TABLE routine_states
  ADD COLUMN IF NOT EXISTS reask_count INTEGER NOT NULL DEFAULT 0;
