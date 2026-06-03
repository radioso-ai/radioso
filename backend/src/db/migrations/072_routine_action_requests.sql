-- Durable outbox for fire-and-forget actions a conversation Routine requested. The
-- chat turn records a row (transactionally with the turn) and confirms to the user
-- immediately; a worker-driven dispatcher later routes each `pending` row by `type` to
-- a registered handler that performs the side effect (idempotently, with retries).
-- The conversation never blocks on the side effect.

CREATE TABLE IF NOT EXISTS routine_action_requests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  workspace_id     UUID,
  account_id       UUID,
  conversation_id  UUID,
  idempotency_key  TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent enqueue: an action request with the same key is recorded once.
CREATE UNIQUE INDEX IF NOT EXISTS routine_action_requests_idempotency_idx
  ON routine_action_requests (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The dispatcher drains pending rows oldest-first.
CREATE INDEX IF NOT EXISTS routine_action_requests_pending_idx
  ON routine_action_requests (created_at)
  WHERE status = 'pending';
