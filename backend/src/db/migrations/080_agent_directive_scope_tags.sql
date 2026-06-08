ALTER TABLE agent_directives
  ADD COLUMN scope_tags TEXT[] NOT NULL DEFAULT '{}'::text[];
