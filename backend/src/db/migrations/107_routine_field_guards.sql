-- Persist deterministic `field` routine transition guards.
--
-- The `field` guard (branch in code on a resolved slot/skill-output value) is supported
-- end to end in the domain schema, validator, compiler, runtime evaluator, conversation
-- contract, and the prose/form authoring UIs — but it was never given a persistence
-- layer: `routine_transition` had no field columns and the guard_kind CHECK rejected
-- 'field', so publishing a field-guarded routine failed with a constraint violation.
-- This migration lands the missing columns and widens the guard_kind allow-list.

ALTER TABLE routine_transition
  ADD COLUMN IF NOT EXISTS field_ref text,
  ADD COLUMN IF NOT EXISTS field_op text,
  ADD COLUMN IF NOT EXISTS field_value jsonb,
  ADD COLUMN IF NOT EXISTS field_values jsonb,
  ADD COLUMN IF NOT EXISTS field_unit text;

-- Replace whatever guard_kind CHECK currently exists (its name and allow-list have drifted
-- across 085/089) with the canonical set, now including 'field'. Dropping by discovered
-- name keeps this robust to the historical naming.
DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'routine_transition'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%guard_kind%'
  LOOP
    EXECUTE format('ALTER TABLE routine_transition DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  -- Normalize any legacy rows before re-adding the (immediately validated) CHECK. Migration
  -- 089 narrowed the allow-list and paired it with this same UPDATE; on a database where 089's
  -- data step never ran or only partially applied, rows can still hold 'always'/'fallback', and
  -- a non-NOT-VALID ADD CONSTRAINT would abort the migration (and backend startup) on them.
  UPDATE routine_transition SET guard_kind = 'default' WHERE guard_kind IN ('always', 'fallback');

  ALTER TABLE routine_transition
    ADD CONSTRAINT routine_transition_guard_kind_check
    CHECK (guard_kind IN ('llm', 'default', 'slot_filled', 'outcome', 'counter', 'field'));
END $$;
