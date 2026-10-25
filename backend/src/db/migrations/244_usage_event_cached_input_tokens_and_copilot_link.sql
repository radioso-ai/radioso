-- Cached input tokens (#1579): nullable usage_events.cached_input_tokens, no default. A missing
-- value means the provider did not report cache usage for that call, the same convention
-- reasoning_tokens already uses.
--
-- Ray's own conversation and per-turn message (#1579): usage_events.copilot_conversation_id and
-- .copilot_message_id, foreign-keyed to copilot_conversations/copilot_messages -- deliberately
-- separate columns from conversation_id/message_id, which are foreign-keyed to the assistant's
-- conversations/messages and must never hold a Ray id (see durableUsageEventRecorder.ts). Both
-- ON DELETE SET NULL: Ray's own retention sweep (copilotRetentionWorker) and conversation erasure
-- alike remove the link, never the ledger row -- the spend is the record.
--
-- usage_events is small in production (~27k rows EU, ~14k US as of 2026-10-17), so plain DDL and
-- a plain index build under a bounded lock wait are fine; no CONCURRENTLY runbook needed (compare
-- the three-second bound migration 228_conversation_erasure_usage_events.sql already uses for the
-- same table).
SET LOCAL lock_timeout = '3s';

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS cached_input_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS copilot_conversation_id UUID REFERENCES copilot_conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS copilot_message_id UUID REFERENCES copilot_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS usage_events_copilot_conversation_idx
  ON usage_events (copilot_conversation_id) WHERE copilot_conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS usage_events_copilot_message_idx
  ON usage_events (copilot_message_id) WHERE copilot_message_id IS NOT NULL;
