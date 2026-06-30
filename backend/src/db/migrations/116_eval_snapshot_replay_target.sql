ALTER TABLE public.eval_snapshots
  ADD COLUMN IF NOT EXISTS replay_target JSONB;

