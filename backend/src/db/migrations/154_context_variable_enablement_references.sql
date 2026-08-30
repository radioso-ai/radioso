-- Existing service and transaction-local repository checks enforce same-workspace and same-agent
-- ownership. NOT VALID preserves any historical orphan rows for operator-guided cleanup while
-- enforcing both references for new writes and referenced-row deletes from this migration onward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent_context_variables'::regclass
      AND conname = 'agent_context_variables_agent_id_fkey'
  ) THEN
    ALTER TABLE agent_context_variables
      ADD CONSTRAINT agent_context_variables_agent_id_fkey
      FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE NOT VALID;
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent_context_variables'::regclass
      AND conname = 'agent_context_variables_resolver_skill_id_fkey'
  ) THEN
    ALTER TABLE agent_context_variables
      ADD CONSTRAINT agent_context_variables_resolver_skill_id_fkey
      FOREIGN KEY (resolver_skill_id) REFERENCES agent_skills(id) ON DELETE CASCADE NOT VALID;
  END IF;
END;
$$;
