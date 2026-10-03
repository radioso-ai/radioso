-- A reply the customer may not have received: a delivery failure the channel that carries the reply
-- raises on its conversation, and clears when a later send on the conversation is delivered, when
-- provider evidence settles it, or when a teammate acknowledges or resolves it. Channel-neutral:
-- `provider` names the channel's provider, and the kinds are outcomes any channel can report.
--
--   bounced    the provider reported the reply bounced or suppressed
--   failed     the provider refused it, or reported it failed
--   uncertain  its outcome is unknown and the channel will not send it again on its own
--   halted     it never went out: the channel's authority to send was gone before the first attempt
--
-- One failure is open per message at a time; a message raises a new one only once its last has
-- cleared. A failure that names no message counts as one message for that rule.
--
-- `detail_code` is the provider's code, sanitized; never its bounce message, which may quote the
-- recipient.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on conversations and messages until this commits:
-- reads continue, writes to those tables wait. The table is new, so the migration takes
-- milliseconds. It waits at most three seconds for those locks, as 209 does.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS conversation_delivery_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  failure_kind TEXT NOT NULL CHECK (failure_kind IN ('bounced', 'failed', 'uncertain', 'halted')),
  detail_code TEXT,
  -- To the millisecond, so the open-failure list's cursor carries it exactly through a JavaScript
  -- Date, and failures opened in one transaction tie on it and order by id.
  opened_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now()),
  cleared_at TIMESTAMPTZ,
  -- The teammate who acknowledged or resolved it; null when the channel cleared it.
  cleared_by_user_id UUID,
  clear_reason TEXT
    CHECK (clear_reason IN ('acknowledged', 'later_delivery', 'provider_evidence', 'operator_resolved')),
  -- A failure is open, or cleared with a reason; only a cleared one names who cleared it.
  CONSTRAINT conversation_delivery_failures_cleared_check CHECK (
    (cleared_at IS NULL AND clear_reason IS NULL AND cleared_by_user_id IS NULL)
    OR (cleared_at IS NOT NULL AND clear_reason IS NOT NULL)
  )
);

-- One open failure per message, which makes raising one idempotent; a conversation's open failures.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_delivery_failures_open_message_uniq
  ON conversation_delivery_failures (conversation_id, message_id) NULLS NOT DISTINCT
  WHERE cleared_at IS NULL;

-- The Inbox and Ray: a workspace's open failures, newest first.
CREATE INDEX IF NOT EXISTS conversation_delivery_failures_workspace_open_idx
  ON conversation_delivery_failures (workspace_id, opened_at)
  WHERE cleared_at IS NULL;
