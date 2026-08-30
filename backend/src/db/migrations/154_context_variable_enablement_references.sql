-- Existing service and transaction-local repository checks enforce same-workspace and same-agent
-- ownership. NOT VALID preserves any historical orphan rows for operator-guided cleanup while
-- enforcing both references for new writes and referenced-row deletes from this migration onward.
ALTER TABLE agent_context_variables
  ADD CONSTRAINT agent_context_variables_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE agent_context_variables
  ADD CONSTRAINT agent_context_variables_resolver_skill_id_fkey
  FOREIGN KEY (resolver_skill_id) REFERENCES agent_skills(id) ON DELETE CASCADE NOT VALID;
