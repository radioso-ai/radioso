-- Store the full non-redacted internal AgentConfig used by new eval
-- snapshots while preserving legacy thin original_agent rows.

ALTER TABLE eval_snapshots
  ADD COLUMN IF NOT EXISTS original_agent_config JSONB,
  ADD COLUMN IF NOT EXISTS source_agent_id UUID;
