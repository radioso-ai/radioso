-- Reversible off switch (#1111): an operator can turn a misfiring directive off without
-- losing its authored text. Defaults true so every existing directive stays live.
ALTER TABLE agent_directives
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;
