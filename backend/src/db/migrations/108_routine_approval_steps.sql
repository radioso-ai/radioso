-- Approval gates are authored in both routine editors (issue #755). The domain, compiler,
-- validator, and runtime already understand the `approval` step kind, but the persistence
-- layer never did: routine_step had no columns for an approval step's capture key / options,
-- and its kind CHECK rejected 'approval' outright (inserting one raised a constraint
-- violation -> 500). Allow the kind and add the columns so an authored gate survives a save.
DO $$
BEGIN
  IF to_regclass('public.routine_step') IS NOT NULL THEN
    ALTER TABLE routine_step
      ADD COLUMN IF NOT EXISTS capture_key TEXT NULL,
      ADD COLUMN IF NOT EXISTS options JSONB NULL;

    ALTER TABLE routine_step
      DROP CONSTRAINT IF EXISTS routine_step_kind_check;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'public.routine_step'::regclass
        AND conname = 'routine_step_kind_check'
    ) THEN
      ALTER TABLE routine_step
        ADD CONSTRAINT routine_step_kind_check CHECK (kind IN ('chat', 'tool', 'action', 'approval'));
    END IF;
  END IF;
END $$;
