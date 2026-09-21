-- A Slack channel binding decides not only which agent answers in a channel but when
-- it speaks: on @mentions only (the default) or on every top-level human message.
-- The installation default binding (channel_id IS NULL) stands in for every channel
-- without its own binding, so it can never answer every message: the table refuses
-- that row whatever the caller does.
ALTER TABLE slack_channel_bindings
  ADD COLUMN respond_mode TEXT NOT NULL DEFAULT 'mention'
  CHECK (respond_mode IN ('mention', 'every_message'));

ALTER TABLE slack_channel_bindings
  ADD CONSTRAINT slack_channel_bindings_default_binding_mention_only
  CHECK (channel_id IS NOT NULL OR respond_mode = 'mention');

-- Subscribing to channel messages writes one inbound event row per message in every
-- joined channel; the retention sweep filters and orders on received_at.
CREATE INDEX IF NOT EXISTS slack_inbound_events_received_at_idx
  ON slack_inbound_events (received_at);
