CREATE TABLE IF NOT EXISTS abuse_control_entries (
  scope TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL,
  blocked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, subject_key)
);

CREATE INDEX IF NOT EXISTS idx_abuse_control_entries_blocked_until
  ON abuse_control_entries (blocked_until);

CREATE INDEX IF NOT EXISTS idx_abuse_control_entries_updated_at
  ON abuse_control_entries (updated_at);
