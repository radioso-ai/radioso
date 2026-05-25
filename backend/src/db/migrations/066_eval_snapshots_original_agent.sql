-- Replace `eval_snapshots.original_agent_id UUID` with `original_agent JSONB`.
--
-- Originally captured only the agent id as a foreign-key-ish reference.
-- After the snapshot-decoupling refactor we freeze the agent value object
-- (id + name + instructions + model override) at capture time so future
-- replays can replay against a frozen agent even if the live one changed.
--
-- Idempotent: safe whether the database currently has `original_agent_id`,
-- `original_agent`, or (for databases that applied an earlier in-place edit
-- of 064/065) both. The bare UUID values are not backfilled into the JSONB
-- column — there isn't enough information to reconstruct an AgentSnapshot
-- from the id alone, and these are development snapshots that predate the
-- refactor.

ALTER TABLE eval_snapshots
  ADD COLUMN IF NOT EXISTS original_agent JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'eval_snapshots'
      AND column_name = 'original_agent_id'
  ) THEN
    ALTER TABLE eval_snapshots DROP COLUMN original_agent_id;
  END IF;
END
$$;
