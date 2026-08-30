-- Resolver proposal writes lock agent_skills before writing their enablement. Deactivating
-- dependents in the skill update transaction preserves that lock order and keeps the invariant
-- atomic for every skill writer. The resolver configuration remains available for an operator to
-- re-enable explicitly after the skill is restored; re-enabling the skill does not opt variables
-- back in automatically.
CREATE OR REPLACE FUNCTION disable_context_variable_enablements_with_resolver_skill()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE agent_context_variables
  SET enabled = FALSE,
      -- A proposal can hold the skill row lock while this transaction waits. `NOW()` is fixed at
      -- transaction start and could move the enablement version backwards after that wait.
      updated_at = clock_timestamp()
  WHERE resolver_skill_id = NEW.id
    AND enabled = TRUE;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_agent_skills_disable_context_variable_enablements
AFTER UPDATE OF enabled ON agent_skills
FOR EACH ROW
WHEN (OLD.enabled IS TRUE AND NEW.enabled IS FALSE)
EXECUTE FUNCTION disable_context_variable_enablements_with_resolver_skill();
