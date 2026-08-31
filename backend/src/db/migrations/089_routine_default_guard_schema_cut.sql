DO $$
BEGIN
  IF to_regclass('public.routine_step') IS NOT NULL THEN
    UPDATE routine_step
    SET kind = 'chat'
    WHERE kind = 'fork';

    ALTER TABLE routine_step
      DROP CONSTRAINT IF EXISTS routine_step_kind_check;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.routine_step'::regclass
        AND conname = 'routine_step_kind_check'
    ) THEN
      ALTER TABLE routine_step
        ADD CONSTRAINT routine_step_kind_check CHECK (kind IN ('chat', 'tool', 'action'));
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  IF to_regclass('public.routine_transition') IS NOT NULL THEN
    FOR constraint_name IN
      SELECT con.conname
      FROM pg_constraint con
      WHERE con.conrelid = 'public.routine_transition'::regclass
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) LIKE '%guard_kind%'
    LOOP
      EXECUTE format('ALTER TABLE routine_transition DROP CONSTRAINT %I', constraint_name);
    END LOOP;

    UPDATE routine_transition
    SET guard_kind = 'default'
    WHERE guard_kind IN ('always', 'fallback');

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.routine_transition'::regclass
        AND conname = 'routine_transition_guard_kind_check'
    ) THEN
      ALTER TABLE routine_transition
        ADD CONSTRAINT routine_transition_guard_kind_check
        CHECK (guard_kind IN ('llm', 'default', 'slot_filled', 'outcome', 'counter', 'field'));
    END IF;
  END IF;
END $$;
