-- Provider-reported cached input tokens for a model call (#1579): the portion of the prompt a
-- provider served from its own cache rather than reprocessing. Nullable with no default: a missing
-- value means the provider did not report cache usage for that call, not that none was cached --
-- the same convention `reasoning_tokens` already uses.
--
-- A nullable column with no default is a catalog change: no rewrite, no scan, no index. The lock
-- wait is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS cached_input_tokens BIGINT;
