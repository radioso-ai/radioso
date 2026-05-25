-- Reshape eval snapshots, cases, and runs:
--   * eval_snapshots: replace `original_agent_id UUID` with `original_agent
--     JSONB` so we can capture a frozen agent value object (id + name +
--     instructions + model override), not just the live row's id.
--   * eval_cases: replace single `expected_outcome` JSONB object with an
--     `assertions` JSONB array; a case can have 0..N assertions and a run
--     passes iff every assertion passes.
--   * eval_runs: add `assertion_verdicts` JSONB array recording one verdict
--     per assertion that was evaluated against that run's output.
--
-- Before: each case carried a single `expected_outcome` JSONB object.
-- After:  each case carries an `assertions` JSONB array; each run carries
--         an `assertion_verdicts` JSONB array with one entry per assertion.
--
-- This migration is idempotent: it tolerates being run against a database
-- that was migrated through the original 064 (with `expected_outcome` and
-- `original_agent_id`) as well as one that already has the new columns.

-- eval_snapshots: add `original_agent` JSONB, drop `original_agent_id` UUID.
-- We don't backfill the JSONB value from the bare id — the operator data
-- needed to reconstruct a full AgentSnapshot from just an id isn't worth
-- the complexity for development snapshots that predate this change.
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

-- eval_cases: add `assertions`, copy data, drop `expected_outcome`.
ALTER TABLE eval_cases
  ADD COLUMN IF NOT EXISTS assertions JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'eval_cases'
      AND column_name = 'expected_outcome'
  ) THEN
    -- Wrap any existing single expected_outcome into a single-element array.
    UPDATE eval_cases
       SET assertions = jsonb_build_array(expected_outcome)
     WHERE assertions = '[]'::jsonb
       AND expected_outcome IS NOT NULL;

    ALTER TABLE eval_cases DROP COLUMN expected_outcome;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'eval_cases'
      AND constraint_name = 'eval_cases_assertions_is_array'
  ) THEN
    ALTER TABLE eval_cases
      ADD CONSTRAINT eval_cases_assertions_is_array
      CHECK (jsonb_typeof(assertions) = 'array');
  END IF;
END
$$;

-- eval_runs: add `assertion_verdicts` JSONB array.
ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS assertion_verdicts JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'eval_runs'
      AND constraint_name = 'eval_runs_assertion_verdicts_is_array'
  ) THEN
    ALTER TABLE eval_runs
      ADD CONSTRAINT eval_runs_assertion_verdicts_is_array
      CHECK (jsonb_typeof(assertion_verdicts) = 'array');
  END IF;
END
$$;
