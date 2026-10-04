-- The request running under an operator MCP receipt. `claimRunning` sets it to the receipt's own
-- request. A retry of an `execute_reviewed_proposal` call whose first request stalled past the
-- recovery lease takes the receipt over to reconcile it, and sets it to the retry. Every outcome
-- write is conditional on it, so a request whose receipt was taken over never records its outcome
-- over the attempt that replaced it.
--
-- NULL until a request starts running under the receipt, and on rows written before this column
-- existed. NULL counts as held by the receipt's own request.
--
-- Not a foreign key: it is a fence value, and retention deletes the retry's own receipt on its own
-- schedule.
--
-- A nullable column with no default is a catalog-only change: no table rewrite and no scan. The
-- ALTER holds its ACCESS EXCLUSIVE lock on operator_mcp_invocations only for that instant.
ALTER TABLE operator_mcp_invocations
  ADD COLUMN attempt_invocation_id uuid;
