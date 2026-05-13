ALTER TABLE agents
ADD COLUMN IF NOT EXISTS source_scope_mode TEXT NOT NULL DEFAULT 'all';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agents_source_scope_mode_check'
  ) THEN
    ALTER TABLE agents
    ADD CONSTRAINT agents_source_scope_mode_check
    CHECK (source_scope_mode IN ('all', 'selected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_document_sources (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES document_sources(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_document_sources_source
  ON agent_document_sources (source_id);
