-- Capture the agent's active routine position at snapshot time so a workbench replay
-- can resume the routine mid-flight exactly where the real conversation was. The full
-- RoutineState (routineId, path, variables, attempts, status) is stored verbatim; the
-- replay injects an ephemeral sessionId. NULL when no routine was active at capture.
ALTER TABLE public.eval_snapshots
  ADD COLUMN IF NOT EXISTS original_routine_state jsonb;
