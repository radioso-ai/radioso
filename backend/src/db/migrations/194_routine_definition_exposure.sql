-- A routine can be offered to a calling agent as a named tool. The three columns hold the
-- operator-authored exposure block; the block is absent when exposure_tool_name IS NULL.
-- Tool-name uniqueness is a publish-time rule across the agent's revision snapshot
-- (routines/exposure/exposureSnapshotRules.ts), not a table constraint: two drafts may
-- collide until one of them is published.
ALTER TABLE routine_definition
  ADD COLUMN exposure_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN exposure_tool_name TEXT,
  ADD COLUMN exposure_description TEXT;
