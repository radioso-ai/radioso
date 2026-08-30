-- Repair databases that applied an early topic-census schema before workspace
-- scope was present on membership and transition rows. Current databases already
-- have this shape, so every operation below is idempotent.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_census_runs'::regclass
      AND conname = 'topic_census_runs_workspace_id_id_key'
  ) THEN
    ALTER TABLE topic_census_runs
      ADD CONSTRAINT topic_census_runs_workspace_id_id_key UNIQUE (workspace_id, id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topics'::regclass
      AND conname = 'topics_workspace_id_id_key'
  ) THEN
    ALTER TABLE topics
      ADD CONSTRAINT topics_workspace_id_id_key UNIQUE (workspace_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topics'::regclass
      AND conname = 'topics_workspace_id_created_run_id_fkey'
  ) THEN
    ALTER TABLE topics
      ADD CONSTRAINT topics_workspace_id_created_run_id_fkey
      FOREIGN KEY (workspace_id, created_run_id)
      REFERENCES topic_census_runs(workspace_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topics'::regclass
      AND conname = 'topics_workspace_id_last_seen_run_id_fkey'
  ) THEN
    ALTER TABLE topics
      ADD CONSTRAINT topics_workspace_id_last_seen_run_id_fkey
      FOREIGN KEY (workspace_id, last_seen_run_id)
      REFERENCES topic_census_runs(workspace_id, id);
  END IF;
END
$$;

ALTER TABLE topic_memberships
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

UPDATE topic_memberships AS membership
SET workspace_id = run.workspace_id
FROM topic_census_runs AS run
WHERE membership.workspace_id IS NULL
  AND membership.run_id = run.id;

ALTER TABLE topic_memberships
  ALTER COLUMN workspace_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_memberships'::regclass
      AND conname = 'topic_memberships_workspace_id_fkey'
  ) THEN
    ALTER TABLE topic_memberships
      ADD CONSTRAINT topic_memberships_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_memberships'::regclass
      AND conname = 'topic_memberships_workspace_id_run_id_fkey'
  ) THEN
    ALTER TABLE topic_memberships
      ADD CONSTRAINT topic_memberships_workspace_id_run_id_fkey
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES topic_census_runs(workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_memberships'::regclass
      AND conname = 'topic_memberships_workspace_id_topic_id_fkey'
  ) THEN
    ALTER TABLE topic_memberships
      ADD CONSTRAINT topic_memberships_workspace_id_topic_id_fkey
      FOREIGN KEY (workspace_id, topic_id)
      REFERENCES topics(workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_memberships'::regclass
      AND conname = 'topic_memberships_workspace_id_message_id_fkey'
  ) THEN
    ALTER TABLE topic_memberships
      ADD CONSTRAINT topic_memberships_workspace_id_message_id_fkey
      FOREIGN KEY (workspace_id, message_id)
      REFERENCES messages(workspace_id, id) ON DELETE CASCADE;
  END IF;
END
$$;

ALTER TABLE topic_transitions
  ADD COLUMN IF NOT EXISTS workspace_id UUID;

UPDATE topic_transitions AS transition
SET workspace_id = run.workspace_id
FROM topic_census_runs AS run
WHERE transition.workspace_id IS NULL
  AND transition.run_id = run.id;

ALTER TABLE topic_transitions
  ALTER COLUMN workspace_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_transitions'::regclass
      AND conname = 'topic_transitions_workspace_id_fkey'
  ) THEN
    ALTER TABLE topic_transitions
      ADD CONSTRAINT topic_transitions_workspace_id_fkey
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_transitions'::regclass
      AND conname = 'topic_transitions_workspace_id_run_id_fkey'
  ) THEN
    ALTER TABLE topic_transitions
      ADD CONSTRAINT topic_transitions_workspace_id_run_id_fkey
      FOREIGN KEY (workspace_id, run_id)
      REFERENCES topic_census_runs(workspace_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'topic_transitions'::regclass
      AND conname = 'topic_transitions_workspace_id_topic_id_fkey'
  ) THEN
    ALTER TABLE topic_transitions
      ADD CONSTRAINT topic_transitions_workspace_id_topic_id_fkey
      FOREIGN KEY (workspace_id, topic_id)
      REFERENCES topics(workspace_id, id) ON DELETE CASCADE;
  END IF;
END
$$;
