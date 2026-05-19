ALTER TABLE agent_document_sources
DROP CONSTRAINT IF EXISTS agent_document_sources_pkey;

ALTER TABLE agent_document_sources
ALTER COLUMN source_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_document_sources_agent_source_unique
  ON agent_document_sources (agent_id, source_id)
  WHERE source_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_document_sources_agent_unassigned_unique
  ON agent_document_sources (agent_id)
  WHERE source_id IS NULL;
