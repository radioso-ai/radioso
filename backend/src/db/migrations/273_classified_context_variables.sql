-- Classified attributes (#1884, 1b): an agent's enablement of a context variable gains the
-- `classified` source. Its value is a stored one, like `pushed`, that the classifier also writes:
-- after a turn it reads the conversation and picks one of a Choice variable's options.
--
-- Locks. The CHECK swap takes ACCESS EXCLUSIVE on `agent_context_variables`, which a chat turn
-- does not read (a turn reads its revision's snapshot); agent settings and draft edits wait for it.
-- The table holds one row per agent and attribute, so validating the widened CHECK in the same
-- statement scans a small table. The wait for the lock is bounded to three seconds; a deploy that
-- hits the bound rolls back and a retry is safe.
--
-- Rollback is app-only: the previous release runs on this schema, but it refuses an agent revision
-- snapshot that names `classified`, and a conversation pinned to such a revision fails its turns.
-- Before rolling back, set those agents' attributes to another source and publish them again.
SET LOCAL lock_timeout = '3s';

ALTER TABLE agent_context_variables
  DROP CONSTRAINT agent_context_variables_source_check,
  ADD CONSTRAINT agent_context_variables_source_check
    CHECK (source IN ('pushed', 'browser', 'resolver', 'request', 'classified'));
