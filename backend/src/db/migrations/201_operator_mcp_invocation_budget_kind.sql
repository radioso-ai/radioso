-- Test Chat turns are private, suppress skill effects, and are already metered as answers against
-- the plan quota, so they draw from their own per-minute ceiling instead of sharing the shared
-- verification budget every other probe/propose descriptor draws from. `budget_kind` lets the
-- rolling-window query in operatorMcpInvocationRepository.ts sum each grant's spend per ceiling.
ALTER TABLE operator_mcp_invocations
  ADD COLUMN budget_kind TEXT NOT NULL DEFAULT 'verification'
  CHECK (budget_kind IN ('verification', 'test_chat'));

DROP INDEX operator_mcp_invocations_budget_idx;
CREATE INDEX operator_mcp_invocations_budget_idx
  ON operator_mcp_invocations (grant_id, budget_kind, budget_reserved_at)
  WHERE budget_reserved_at IS NOT NULL;
