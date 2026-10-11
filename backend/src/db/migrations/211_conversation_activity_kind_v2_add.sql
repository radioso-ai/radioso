-- Widens conversation_activity.kind for the email channel, online, in three committed migrations
-- (211, 212, 213), so no step holds a lock that stops writers for longer than a catalog change.
-- This is the first: a second CHECK naming every kind the feature needs, added NOT VALID, so it binds
-- new rows at once without scanning the existing ones.
--
--   channel_exception         mail the channel would not act on, on an existing thread
--   delivery_failed           a reply the customer may not have received
--   delivery_failure_cleared  that failure resolved (closes an Inbox item)
--   held_reply_released       a held draft sent to the customer (closes an Inbox item)
--   held_reply_discarded      a held draft thrown away
--
-- Until 213 drops the original CHECK, both hold, so the new kinds are still refused: code that writes
-- them ships after 213.
--
-- Locks. ADD CONSTRAINT takes ACCESS EXCLUSIVE on conversation_activity for the catalog change only.
-- The migration runner disables lock timeouts for a migration's body, so this sets its own: a
-- transaction still reading or writing the table makes the deploy fail after three seconds, and the
-- rollback leaves nothing behind, instead of queueing every Inbox read and activity write behind it. A
-- retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE conversation_activity
  DROP CONSTRAINT IF EXISTS conversation_activity_kind_v2_check;

ALTER TABLE conversation_activity
  ADD CONSTRAINT conversation_activity_kind_v2_check CHECK (kind IN (
    'handoff_requested',
    'claimed',
    'reassigned',
    'handed_back',
    'approval_decided',
    'feedback_resolved',
    'feedback_dismissed',
    'channel_exception',
    'delivery_failed',
    'delivery_failure_cleared',
    'held_reply_released',
    'held_reply_discarded'
  )) NOT VALID;
