-- Spec 092 amendment (org parity), Slice 1: channel-scoped answerer routing.
-- A binding now maps (installation, channel) -> answering agent. channel_id NULL is the
-- default answerer for the installation (DMs + channels with no explicit binding).
-- Existing rows (channel_id NULL) become the default answerer -> behavior-preserving.
ALTER TABLE slack_channel_bindings ADD COLUMN IF NOT EXISTS channel_id TEXT;

-- Replace the one-binding-per-installation constraint with one-binding-per-(installation, channel).
-- NULLS NOT DISTINCT (PostgreSQL 15+) collapses NULL channel_id to a single value, so there is at
-- most one default answerer per installation AND at most one answerer per channel, in one index.
ALTER TABLE slack_channel_bindings
  DROP CONSTRAINT IF EXISTS slack_channel_bindings_installation_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_slack_channel_bindings_install_channel
  ON slack_channel_bindings (installation_id, channel_id) NULLS NOT DISTINCT;
