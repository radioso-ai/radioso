-- Cross-turn firing policy for an authored directive (issue #865). NULL means the
-- historical `repeatable` behavior: the directive may render on every turn its
-- condition holds. A JSONB payload of `{"kind":"once_per_conversation"}` or
-- `{"kind":"cooldown","turns":N}` opts the directive into the firing memory that
-- suppresses re-firing across turns (see the directive_states table).
ALTER TABLE agent_directives
  ADD COLUMN IF NOT EXISTS lifecycle JSONB NULL;
