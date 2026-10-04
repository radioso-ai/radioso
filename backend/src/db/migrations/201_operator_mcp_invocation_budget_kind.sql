-- Test Chat turns are private, suppress skill effects, and are already metered as answers against
-- the plan quota, so they draw from their own per-minute ceiling instead of the shared
-- verification budget every other probe/propose descriptor draws from. `budget_kind` lets the
-- rolling-window query in operatorMcpInvocationRepository.ts sum each grant's spend per ceiling.
--
-- The constant DEFAULT keeps ADD COLUMN free of a table rewrite. The inline CHECK still costs one
-- verification scan of existing rows under the ALTER's lock; this table holds only operator MCP
-- invocations inside their retention window, so that scan is short.
--
-- The existing `operator_mcp_invocations_budget_idx (grant_id, budget_reserved_at)` already
-- narrows a lookup to one grant's last-minute rows before `budget_kind` is even checked, so it is
-- left as-is; there is nothing to gain from rebuilding it around a column this thin.
ALTER TABLE operator_mcp_invocations
  ADD COLUMN budget_kind TEXT NOT NULL DEFAULT 'verification'
  CHECK (budget_kind IN ('verification', 'test_chat'));

-- Reclassifies only rows a rolling-window budget check can still see (a window closes within a
-- minute, ten covers replay/clock slop): a Test Chat call admitted moments before this migration
-- ran was reserved under the old, unconditional 'verification' default, and would otherwise spend
-- against the wrong ceiling for the rest of its window. Bounded by budget_reserved_at, not a
-- full-table scan.
UPDATE operator_mcp_invocations
SET budget_kind = 'test_chat'
WHERE descriptor_name = 'send_test_chat_message'
  AND budget_reserved_at IS NOT NULL
  AND budget_reserved_at >= NOW() - INTERVAL '10 minutes';
