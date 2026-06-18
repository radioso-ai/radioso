CREATE TABLE IF NOT EXISTS conversation_ownership (
  conversation_id     UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id        UUID NOT NULL,
  state               TEXT NOT NULL,
  owner_account_id    UUID,
  owner_display_name  TEXT,
  reason              TEXT,
  version             INTEGER NOT NULL DEFAULT 1,
  taken_over_at       TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_ownership_workspace_idx
  ON conversation_ownership (workspace_id);
