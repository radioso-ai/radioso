-- Generic, session-scoped persistence for a pending clarification question.
-- Candidate payloads are opaque to the Clarifier and are owned by the source
-- surface; rows retain non-pending outcomes until TTL for loop-guard checks.

CREATE TABLE IF NOT EXISTS clarification_states (
  session_id      UUID PRIMARY KEY,
  source          TEXT NOT NULL,
  candidates      JSONB NOT NULL DEFAULT '[]'::jsonb,
  asked_event_id  TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clarification_states_pending_idx
  ON clarification_states (session_id)
  WHERE status = 'pending';
