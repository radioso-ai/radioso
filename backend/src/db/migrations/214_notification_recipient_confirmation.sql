-- Per-workspace recipient confirmation and deployment-wide deliverability suppression.
-- The grandfather deadline is data stamped when this migration runs, so mixed revisions and
-- later policy changes never reinterpret when an existing recipient's grace period began.
CREATE TABLE notification_recipient_confirmations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL CHECK (normalized_email = lower(btrim(normalized_email)) AND normalized_email <> ''),
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'grandfathered', 'revoked')),
  grandfathered_until TIMESTAMPTZ,
  confirmation_sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  confirmation_generation INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_generation >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, normalized_email),
  CHECK ((state = 'grandfathered') = (grandfathered_until IS NOT NULL))
);

CREATE INDEX notification_recipient_confirmations_workspace_idx
  ON notification_recipient_confirmations (workspace_id, state);

CREATE TABLE notification_recipient_confirmation_daily_usage (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  send_count INTEGER NOT NULL CHECK (send_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, usage_date)
);

CREATE TABLE notification_email_suppressions (
  normalized_email TEXT PRIMARY KEY CHECK (normalized_email = lower(btrim(normalized_email)) AND normalized_email <> ''),
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint')),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH configured_recipients AS (
  SELECT a.workspace_id, lower(btrim(recipient.value)) AS normalized_email
  FROM agents a
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(a.behavior_settings #> '{contactRequestDelivery,recipientEmails}') = 'array'
        THEN a.behavior_settings #> '{contactRequestDelivery,recipientEmails}'
      ELSE '[]'::jsonb
    END
  ) AS recipient(value)
  UNION
  SELECT s.workspace_id, lower(btrim(recipient.value)) AS normalized_email
  FROM agent_skills s
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN s.kind = 'notify' AND jsonb_typeof(s.config #> '{delivery,recipientEmails}') = 'array'
        THEN s.config #> '{delivery,recipientEmails}'
      ELSE '[]'::jsonb
    END
  ) AS recipient(value)
)
INSERT INTO notification_recipient_confirmations (
  workspace_id,
  normalized_email,
  state,
  grandfathered_until
)
SELECT DISTINCT workspace_id, normalized_email, 'grandfathered', CURRENT_TIMESTAMP + INTERVAL '14 days'
FROM configured_recipients
WHERE normalized_email <> ''
ON CONFLICT (workspace_id, normalized_email) DO NOTHING;
