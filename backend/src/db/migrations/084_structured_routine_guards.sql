ALTER TABLE routine_states
  ADD COLUMN IF NOT EXISTS attempts JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE routine_transition
  ADD COLUMN IF NOT EXISTS outcome_status TEXT NULL,
  ADD COLUMN IF NOT EXISTS counter_limit INTEGER NULL;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  SELECT con.conname
    INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'routine_transition'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%guard_kind%'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE routine_transition DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE routine_transition
  ADD CHECK (guard_kind IN ('llm', 'always', 'fallback', 'slot_filled', 'outcome', 'counter')),
  ADD CHECK (counter_limit IS NULL OR counter_limit > 0);
