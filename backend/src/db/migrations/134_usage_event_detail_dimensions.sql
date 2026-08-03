-- Detailed usage reporting needs a provider-reported reasoning dimension and
-- a durable event kind. The immutable historical ledger lacks enough evidence
-- to classify every zero-vector failure, so ambiguous rows remain `unknown`
-- rather than being guessed as model or embedding.

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS reasoning_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS event_kind TEXT,
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

UPDATE usage_events AS usage_event
SET event_kind = CASE
  WHEN usage_event.idempotency_key LIKE 'model:%' THEN 'model'
  WHEN usage_event.idempotency_key LIKE 'embedding:%'
    OR usage_event.vector_count > 0
    OR EXISTS (
      SELECT 1
      FROM embedding_usage_items AS embedding_item
      WHERE embedding_item.usage_event_id = usage_event.id
    ) THEN 'embedding'
  ELSE 'unknown'
END
WHERE usage_event.event_kind IS NULL;

ALTER TABLE usage_events
  ALTER COLUMN event_kind SET DEFAULT 'unknown',
  ALTER COLUMN event_kind SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'usage_events_event_kind_check'
      AND conrelid = 'usage_events'::regclass
  ) THEN
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_event_kind_check
      CHECK (event_kind IN ('model', 'embedding', 'unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_usage_events_account_occurred_at_id
  ON usage_events (account_id, occurred_at DESC, id DESC);
