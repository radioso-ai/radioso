-- Generic, session-scoped persistence for an in-flight conversation Routine (the
-- stateful-journey runtime). At most one active routine per session; the engine
-- resumes a routine from `path` (the node-index history, last = current step) plus
-- `variables` (captured slots), and clears the row when the routine completes.
-- `expires_at` bounds an abandoned flow so a later turn starts fresh. This is generic
-- runtime state — not specific to any one routine.

CREATE TABLE IF NOT EXISTS routine_states (
  session_id  UUID PRIMARY KEY,
  routine_id  TEXT NOT NULL,
  path        TEXT[] NOT NULL DEFAULT '{}',
  variables   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'active',
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resume lookups are by session for the active flow.
CREATE INDEX IF NOT EXISTS routine_states_active_idx
  ON routine_states (session_id)
  WHERE status = 'active';
