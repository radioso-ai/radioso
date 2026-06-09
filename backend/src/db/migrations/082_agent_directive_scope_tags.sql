ALTER TABLE agent_directives
  ADD COLUMN IF NOT EXISTS scope_tags TEXT[] NOT NULL DEFAULT '{}'::text[];
