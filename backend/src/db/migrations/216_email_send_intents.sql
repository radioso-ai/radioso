-- Outbound email: one send intent per attempt-chain that takes a written message to the customer. The
-- intent is keyed by its action-outbox idempotency key, which it also hands the provider, so a retried
-- or re-POSTed send is the same send. Every writer (the send handler, the provider-event processor, the
-- reconciler, an operator's resolution) moves it through one fenced transition:
-- `UPDATE ... WHERE id = $1 AND version = $2`, with `version` bumped on every write.
--
--   queued     written; not yet accepted (also while an attempt's outcome is unknown and re-POSTs)
--   accepted   the provider took it; delivery not yet reported
--   delivered  the provider reported it delivered
--   bounced    bounced or suppressed
--   failed     refused, or reported failed
--   uncertain  its outcome is unknown and it will not be sent again without an audited resend
--   halted     the authority to send was gone before the first attempt; `halt_reason` says why
--
-- `request_snapshot` holds the frozen request, which is customer content: never logged, and its body
-- is cleared once the intent is terminal. `failure_code` is sanitized.
--
-- The thread index names the send intent that took each outbound message out; 209 left that link for
-- this migration, which creates its target. The held-reply link waits for 218.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on email_mailboxes, conversations and messages until
-- this commits, and linking the thread index takes it on email_thread_messages while it checks the
-- index's rows, all of whose send_intent_id are still null: reads continue, writes to those tables
-- wait. The migration takes milliseconds, and it waits at most three seconds for those locks, as 209
-- does.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS email_send_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- Foreign key added by 218, which creates held_replies.
  held_reply_id UUID,
  -- The action-outbox key: `email:send:msg:<id>`, `email:send:held:<id>` or `…:resend:<n>`.
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'operator')),
  trigger TEXT NOT NULL CHECK (trigger IN ('operator_reply', 'held_release', 'auto_reply', 'audited_resend')),
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'accepted', 'delivered', 'bounced', 'failed', 'uncertain', 'halted')),
  -- The fence every writer compares and bumps.
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  halt_reason TEXT CHECK (halt_reason IN ('sending_not_verified', 'domain_removed', 'mailbox_removed')),
  -- The policy, ownership and domain the send was authorized under.
  authority_snapshot JSONB NOT NULL,
  -- Frozen on the first attempt, so every re-POST under the key sends the same request.
  request_snapshot JSONB,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  -- The Message-Id Radioso generated, and the one the provider delivered under when it differs.
  supplied_rfc_message_id TEXT NOT NULL,
  delivered_rfc_message_id TEXT,
  first_attempt_at TIMESTAMPTZ,
  outcome_unknown_since TIMESTAMPTZ,
  -- The reconciler's schedule and its claim: a sweep leases an intent until `reconcile_lease_until`,
  -- so two sweeps never look the same intent up.
  next_reconcile_at TIMESTAMPTZ,
  reconcile_lease_until TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  complained_at TIMESTAMPTZ,
  failure_code TEXT,
  -- How an uncertain (or, for a resend, halted) intent was settled.
  uncertain_resolution TEXT
    CHECK (uncertain_resolution IN ('provider_evidence', 'marked_sent', 'resend_authorized')),
  uncertain_resolved_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Only a halted intent has a halt reason, and every halted one has.
  CONSTRAINT email_send_intents_halted_check CHECK ((state = 'halted') = (halt_reason IS NOT NULL)),
  -- An accepted intent carries the provider's id for it.
  CONSTRAINT email_send_intents_accepted_check CHECK (state <> 'accepted' OR provider_message_id IS NOT NULL),
  -- A resolution settles an intent no longer in flight, and only a resolved intent names its resolver.
  CONSTRAINT email_send_intents_resolution_check CHECK (
    (uncertain_resolution IS NULL OR state NOT IN ('queued', 'accepted'))
    AND (uncertain_resolved_by_user_id IS NULL OR uncertain_resolution IS NOT NULL)
  )
);

-- One intent per outbox key: materializing it again finds the first.
CREATE UNIQUE INDEX IF NOT EXISTS email_send_intents_idempotency_key_uniq
  ON email_send_intents (idempotency_key);

-- Provider delivery events and lookups find their intent by the provider's id.
CREATE UNIQUE INDEX IF NOT EXISTS email_send_intents_provider_message_uniq
  ON email_send_intents (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- A message's intents: its delivery state on the conversation, and its resends.
CREATE INDEX IF NOT EXISTS email_send_intents_message_idx
  ON email_send_intents (message_id);

-- The reconciler's claim: unsettled intents due for a re-POST or a lookup.
CREATE INDEX IF NOT EXISTS email_send_intents_reconcile_due_idx
  ON email_send_intents (next_reconcile_at)
  WHERE state IN ('queued', 'accepted', 'uncertain') AND next_reconcile_at IS NOT NULL;

-- A mailbox's sends by state: what a domain or mailbox removal halts, and the backlog gauge.
CREATE INDEX IF NOT EXISTS email_send_intents_mailbox_state_idx
  ON email_send_intents (mailbox_id, state);

-- The thread index names the send intent that took each outbound message out. An intent goes only with
-- its message or conversation, which take the index row with them, so the link clears rather than
-- refusing whichever cascade runs first.
ALTER TABLE email_thread_messages
  DROP CONSTRAINT IF EXISTS email_thread_messages_send_intent_id_fkey;

ALTER TABLE email_thread_messages
  ADD CONSTRAINT email_thread_messages_send_intent_id_fkey
  FOREIGN KEY (send_intent_id) REFERENCES email_send_intents(id) ON DELETE SET NULL;
