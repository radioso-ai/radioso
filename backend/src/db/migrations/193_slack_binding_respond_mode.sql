-- A Slack channel binding decides not only which agent answers in a channel but when
-- it speaks: on @mentions only (the default) or on every top-level human message.
-- The installation default binding (channel_id IS NULL) always stays 'mention'; the
-- binding service enforces that, the column only carries the value.
ALTER TABLE slack_channel_bindings
  ADD COLUMN respond_mode TEXT NOT NULL DEFAULT 'mention'
  CHECK (respond_mode IN ('mention', 'every_message'));
