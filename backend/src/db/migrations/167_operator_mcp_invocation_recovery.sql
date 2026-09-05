DROP INDEX operator_mcp_invocations_operation_idx;

CREATE UNIQUE INDEX operator_mcp_invocations_operation_idx
  ON operator_mcp_invocations (grant_id, operation_id)
  WHERE operation_id IS NOT NULL
    AND (status <> 'refused' OR safe_outcome_code IS DISTINCT FROM 'abandoned_before_effect');

DROP INDEX copilot_proposals_operator_mcp_invocation_idx;

CREATE UNIQUE INDEX copilot_proposals_operator_mcp_invocation_idx
  ON copilot_proposals (operator_mcp_invocation_id)
  WHERE operator_mcp_invocation_id IS NOT NULL;
