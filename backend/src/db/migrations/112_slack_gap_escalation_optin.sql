ALTER TABLE slack_channel_bindings
  ADD COLUMN IF NOT EXISTS gap_escalation_enabled boolean NOT NULL DEFAULT false;

UPDATE slack_channel_bindings
SET gap_escalation_enabled = true
WHERE escalation_channel_id IS NOT NULL;
