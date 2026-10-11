-- Durable, low-cardinality admission decisions for outbound contact and operator-notification
-- delivery. One row per action request and normalized recipient snapshot makes exact retries
-- idempotent while a changed list needs a new admission; the two indexes support the workspace/day
-- recipient-attempt sum and per-conversation dispatch count under an advisory lock.
CREATE TABLE notification_delivery_outcomes (
  request_id UUID NOT NULL,
  recipient_digest TEXT NOT NULL,
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  usage_date DATE NOT NULL,
  requested_email_count INTEGER NOT NULL CHECK (requested_email_count >= 0),
  reserved_email_count INTEGER NOT NULL CHECK (reserved_email_count >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'allowed',
    'workspace_daily_email_cap',
    'conversation_dispatch_cap'
  )),
  daily_email_limit INTEGER NOT NULL CHECK (daily_email_limit >= 0),
  conversation_dispatch_limit INTEGER NOT NULL CHECK (conversation_dispatch_limit >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, recipient_digest)
);

CREATE INDEX notification_delivery_outcomes_workspace_day_idx
  ON notification_delivery_outcomes (workspace_id, usage_date);

CREATE INDEX notification_delivery_outcomes_conversation_idx
  ON notification_delivery_outcomes (workspace_id, conversation_id);
