-- What happened to each address of each notice: one row per action request and normalized address,
-- so an operator can answer "did that email go out, and to whom?". A retry of the same request
-- updates its rows, and a row that reads 'sent' is never overwritten (the application keeps it so).
--
-- The log is about the operator's own recipients, not the visitor: it holds an address, a kind and an
-- outcome, never message content. It follows its conversation (deleting the conversation, by
-- erasure or retention, deletes its rows) and its workspace; an agent that is deleted leaves its
-- rows without an agent. Nothing else prunes it.
--
-- The throttle for the "this address is not getting notices" alert lives on the address's
-- existing confirmation row: a nullable timestamp that a conditional UPDATE claims, so two workers
-- cannot both alert for the same address in the same day.
--
-- Locks. The whole file is one transaction, so every lock is held until it commits. The small
-- confirmations table goes first. The new table's foreign keys take SHARE ROW EXCLUSIVE on
-- workspaces, agents and conversations for the instant the table is created, which leaves reads
-- running but waits for in-flight writers. The wait for each lock is bounded to three seconds; a
-- deploy that hits it rolls back and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE notification_recipient_confirmations
  ADD COLUMN undelivered_alert_sent_at TIMESTAMPTZ;

CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contact_request', 'approval', 'handoff', 'completion')),
  recipient_email TEXT NOT NULL CHECK (recipient_email = lower(btrim(recipient_email)) AND recipient_email <> ''),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'sent',
    'skipped_unconfirmed',
    'skipped_revoked',
    'skipped_suppressed',
    'skipped_cap',
    'not_dispatched',
    'failed'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, recipient_email)
);

-- The workspace log, newest first, and the same narrowed to one agent.
CREATE INDEX notification_deliveries_workspace_idx
  ON notification_deliveries (workspace_id, created_at DESC, id DESC);

CREATE INDEX notification_deliveries_agent_idx
  ON notification_deliveries (agent_id, created_at DESC, id DESC)
  WHERE agent_id IS NOT NULL;

-- A conversation's deletion finds its rows.
CREATE INDEX notification_deliveries_conversation_idx
  ON notification_deliveries (conversation_id);
