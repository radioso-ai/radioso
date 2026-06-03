-- Make the action outbox safe to drain concurrently and to retry transient failures.
-- A claim atomically moves a row pending -> in_progress (lease via updated_at) so two
-- workers/drains can't dispatch the same row; a transient handler failure reschedules
-- the row to pending with a `next_attempt_at` backoff until the retry budget is spent.

ALTER TABLE routine_action_requests
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

-- The drain claims pending-and-due rows plus in_progress rows whose lease has expired
-- (a crashed worker), oldest first. Replace the pending-only index with one covering
-- both claimable states.
DROP INDEX IF EXISTS routine_action_requests_pending_idx;
CREATE INDEX IF NOT EXISTS routine_action_requests_claimable_idx
  ON routine_action_requests (created_at)
  WHERE status IN ('pending', 'in_progress');
