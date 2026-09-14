-- Test Chat turns are produced from a revision-owned runtime surface (routines
-- and context-variable enablements), not only the baseline agent config.
ALTER TABLE public.eval_snapshots
  ADD COLUMN IF NOT EXISTS test_execution_replay JSONB;
