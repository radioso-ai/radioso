-- Inbound email, durably. `email_inbound_events` holds one row per verified provider webhook delivery
-- of any kind: the processing obligation the webhook leaves behind, deduplicated on the provider's
-- event id. `email_inbound_deliveries` holds one processing unit per event and mailbox: the mailbox
-- event log row, the holder of the message's content, and the thread-reservation log that lets a
-- follow-up and its parent find each other whichever is processed first. A delivery's planned
-- conversation, message and thread ids are reservations, not references, so they carry no foreign key.
--
-- `workspace_id` is null only for mail to a relay token that was never issued. It cascades from the
-- workspace, so deleting a workspace removes every delivery attributed to it, including mail that never
-- reached a conversation: dropped mail, and mail to an unknown address on a direct-receiving domain.
--
-- Envelopes, bodies and raw MIME are customer content: never logged.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on workspaces, conversations and messages until this
-- commits, and linking the thread index takes it on email_thread_messages, created by 209 and still
-- empty. The migration takes milliseconds, and it waits at most three seconds for those locks, as 209
-- does.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS email_inbound_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  -- The webhook's `svix-id`.
  provider_event_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('message_received', 'delivery_status', 'domain_status', 'unsupported')),
  provider_object_id TEXT,
  -- Verified webhook metadata.
  envelope JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'processed', 'failed', 'ignored')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  last_error_code TEXT,
  -- When the webhook was accepted: the moment whose mailbox policy governs the mail.
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_events_provider_event_uniq
  ON email_inbound_events (provider, provider_event_id);

-- One received message is one obligation, however many webhook deliveries announce it.
CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_events_received_object_uniq
  ON email_inbound_events (provider, provider_object_id)
  WHERE event_kind = 'message_received';

-- The inbound drain: events due for an attempt.
CREATE INDEX IF NOT EXISTS email_inbound_events_due_idx
  ON email_inbound_events (next_attempt_at)
  WHERE state IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS email_inbound_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_event_id UUID NOT NULL REFERENCES email_inbound_events(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  mailbox_id UUID REFERENCES email_mailboxes(id) ON DELETE RESTRICT,
  -- Which rule mapped the recipient to the mailbox.
  route_rule TEXT CHECK (route_rule IN ('relay', 'direct')),
  -- The mailbox policy version effective at the event's `received_at`.
  accepted_policy_version INTEGER,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'fetched', 'resolved', 'ingested', 'done', 'failed')),
  classification TEXT
    CHECK (classification IN ('person', 'automated_sender', 'bounce', 'self_sender', 'spam')),
  disposition TEXT CHECK (disposition IN ('ingest_only', 'run_review_turn', 'drop')),
  disposition_reason TEXT CHECK (disposition_reason IN (
    'no_mailbox',
    'mailbox_disabled',
    'automated_sender',
    'self_sender',
    'bounce',
    'spam',
    'participant_mismatch',
    'operator_only_mailbox',
    'human_owned',
    'generation_budget',
    'spam_opt_in',
    'no_agent',
    'accepted'
  )),
  sender_address TEXT,
  sender_display_name TEXT,
  subject TEXT,
  rfc_message_id TEXT,
  -- `References` and `In-Reply-To`, normalized.
  reference_ids TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  received_for TEXT[] NOT NULL DEFAULT '{}',
  auth_results JSONB NOT NULL DEFAULT '{}'::jsonb,
  spam_verdict TEXT NOT NULL DEFAULT 'unknown' CHECK (spam_verdict IN ('spam', 'not_spam', 'unknown')),
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  body_text TEXT,
  strip_confidence TEXT CHECK (strip_confidence IN ('confident', 'full_text')),
  -- Capped; `raw_truncated` says whether the cap cut it.
  raw_mime BYTEA,
  raw_size_bytes INTEGER,
  raw_truncated BOOLEAN NOT NULL DEFAULT false,
  thread_match TEXT
    CHECK (thread_match IN ('in_reply_to', 'references', 'reverse_reference', 'thread_token', 'new_thread')),
  thread_conflict BOOLEAN NOT NULL DEFAULT false,
  -- The reservation: what ingest will create, or join, for this delivery.
  planned_conversation_id UUID,
  planned_message_id UUID,
  planned_thread_key UUID,
  planned_thread_token TEXT,
  -- Set once ingest has committed.
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- One delivery per event and mailbox. Not partial: a null mailbox never conflicts here, so the rule is
-- the same as one limited to non-null mailboxes, and the index also serves an event's deliveries and
-- the cascade from its event.
CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_deliveries_event_mailbox_uniq
  ON email_inbound_deliveries (inbound_event_id, mailbox_id);

-- At most one unrouted delivery per event.
CREATE UNIQUE INDEX IF NOT EXISTS email_inbound_deliveries_event_unrouted_uniq
  ON email_inbound_deliveries (inbound_event_id)
  WHERE mailbox_id IS NULL;

-- A mailbox's event log, newest first.
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_mailbox_created_idx
  ON email_inbound_deliveries (mailbox_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_inbound_deliveries_workspace_created_idx
  ON email_inbound_deliveries (workspace_id, created_at DESC);

-- Retention: content that never reached a conversation.
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_unattached_created_idx
  ON email_inbound_deliveries (created_at)
  WHERE conversation_id IS NULL;

-- Forward reservation lookup: an in-flight or finished delivery of the mailbox carrying a referenced
-- Message-Id.
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_reservation_idx
  ON email_inbound_deliveries (mailbox_id, rfc_message_id)
  WHERE state IN ('resolved', 'ingested', 'done');

-- Reverse lookup: deliveries that reference this Message-Id, filtered by mailbox.
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_reference_ids_idx
  ON email_inbound_deliveries USING GIN (reference_ids);

-- The thread index names the delivery that brought each inbound message in. A delivery removed by
-- retention leaves the index row standing.
ALTER TABLE email_thread_messages
  DROP CONSTRAINT IF EXISTS email_thread_messages_inbound_delivery_id_fkey;

ALTER TABLE email_thread_messages
  ADD CONSTRAINT email_thread_messages_inbound_delivery_id_fkey
  FOREIGN KEY (inbound_delivery_id) REFERENCES email_inbound_deliveries(id) ON DELETE SET NULL;
