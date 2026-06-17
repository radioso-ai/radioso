CREATE TABLE IF NOT EXISTS pending_decisions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle           TEXT NOT NULL,
  conversation_id  UUID NOT NULL,
  session_id       UUID NOT NULL,
  workspace_id     UUID NOT NULL,
  agent_id         UUID NOT NULL,
  routine_id       TEXT NOT NULL,
  step_id          TEXT NOT NULL,
  reason           TEXT,
  options          JSONB NOT NULL DEFAULT '[]'::jsonb,
  decider_scope    JSONB NOT NULL,
  content_hash     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  decision         JSONB,
  decided_by       UUID,
  decided_at       TIMESTAMPTZ,
  deadline         TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS pending_decisions_handle_idx
  ON pending_decisions (handle);

CREATE UNIQUE INDEX IF NOT EXISTS pending_decisions_one_open_gate_idx
  ON pending_decisions (conversation_id, routine_id, step_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pending_decisions_workspace_pending_idx
  ON pending_decisions (workspace_id, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pending_decisions_deadline_pending_idx
  ON pending_decisions (deadline)
  WHERE status = 'pending';
