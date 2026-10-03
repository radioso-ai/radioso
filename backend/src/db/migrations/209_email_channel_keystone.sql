-- The email channel's keystone: a customer domain verified for sending (and, as an advanced option,
-- receiving), the mailboxes on it with their current engagement policy and its append-only history,
-- and per conversation the thread link and the committed index of every RFC Message-Id seen,
-- generated or referenced for a mailbox. The relay domain is deployment configuration, not a row.
--
-- Addresses and domains are stored lowercase, so the uniqueness below is case-insensitive by
-- construction. Thread tokens and relay tokens are secrets: they are never returned by an API or
-- written to a log.
--
-- Mailboxes and domains are removed by setting `removed_at`, never deleted, so history keeps its
-- references: deleting a domain or mailbox row that history still names is refused. Deleting the
-- workspace removes them, through its own cascade and its conversations'.
--
-- The thread index names the delivery that brought a message in and the send intent that took one
-- out. Neither table exists yet: 210 adds the delivery link and 216 the send-intent link, each in the
-- migration that creates its target.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on workspaces, agents, conversations and messages
-- until this commits: reads continue, writes to those tables wait. The tables are new, so the
-- migration takes milliseconds. It waits at most three seconds for those locks, so a long-running
-- writer fails the deploy fast, and the rollback leaves nothing behind, instead of queueing every
-- conversation and message write behind this migration.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS email_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- An IDNA A-label.
  domain TEXT NOT NULL CHECK (domain = lower(domain)),
  provider TEXT NOT NULL CHECK (provider IN ('resend', 'local')),
  provider_domain_id TEXT,
  provider_region TEXT,
  -- DnsRecordView[]: purpose, type, name, value, priority, status.
  dns_records JSONB NOT NULL DEFAULT '[]'::jsonb,
  sending_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (sending_status IN ('pending', 'verified', 'failed')),
  -- Used only by the advanced direct-receiving option.
  receiving_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (receiving_status IN ('not_requested', 'pending', 'verified', 'failed')),
  -- The teammate who typed the domain to confirm its MX points at the provider.
  receiving_confirmed_by_user_id UUID,
  receiving_confirmed_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  next_check_at TIMESTAMPTZ,
  status_changed_at TIMESTAMPTZ,
  -- Authority is revoked first; the provider-side cleanup follows asynchronously.
  removed_at TIMESTAMPTZ,
  provider_cleanup_status TEXT CHECK (provider_cleanup_status IN ('pending', 'done', 'failed')),
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One workspace at a time may register a domain.
CREATE UNIQUE INDEX IF NOT EXISTS email_domains_active_domain_uniq
  ON email_domains (domain)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS email_domains_workspace_idx
  ON email_domains (workspace_id);

-- The status refresh: active domains due for a check.
CREATE INDEX IF NOT EXISTS email_domains_next_check_idx
  ON email_domains (next_check_at)
  WHERE removed_at IS NULL;

-- The direct-receiving rule: is this recipient's domain receiving-verified?
CREATE INDEX IF NOT EXISTS email_domains_receiving_verified_domain_idx
  ON email_domains (domain)
  WHERE receiving_status = 'verified' AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS email_mailboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain_id UUID NOT NULL REFERENCES email_domains(id) ON DELETE RESTRICT,
  -- Null behaves as operator_only.
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  -- local@domain, on the domain of `domain_id`; immutable.
  address TEXT NOT NULL CHECK (address = lower(address)),
  display_name TEXT NOT NULL,
  -- 26-character base32 from at least 128 random bits; the relay address's local part.
  relay_token TEXT NOT NULL,
  -- The token a rotation replaced, still accepted until it expires.
  previous_relay_token TEXT,
  previous_relay_token_expires_at TIMESTAMPTZ,
  -- The current policy. Its default is the service's to choose; the history is email_mailbox_policies.
  engagement_mode TEXT NOT NULL CHECK (engagement_mode IN ('operator_only', 'draft', 'auto')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- The version of the newest email_mailbox_policies row, bumped with every one written.
  policy_version INTEGER NOT NULL DEFAULT 1,
  thread_send_budget INTEGER NOT NULL DEFAULT 3 CHECK (thread_send_budget BETWEEN 1 AND 20),
  hourly_generation_budget INTEGER NOT NULL DEFAULT 30 CHECK (hourly_generation_budget BETWEEN 1 AND 1000),
  generation_window_started_at TIMESTAMPTZ,
  generation_window_count INTEGER NOT NULL DEFAULT 0,
  thread_context_messages INTEGER NOT NULL DEFAULT 10 CHECK (thread_context_messages BETWEEN 1 AND 50),
  spam_opt_in BOOLEAN NOT NULL DEFAULT false,
  silence_threshold_hours INTEGER NOT NULL DEFAULT 72 CHECK (silence_threshold_hours BETWEEN 1 AND 2160),
  plus_address_verified_at TIMESTAMPTZ,
  setup_check_step TEXT CHECK (setup_check_step IN ('base', 'plus_address')),
  setup_check_started_at TIMESTAMPTZ,
  -- Receiving state (waiting, ok, silent) is derived from this and the threshold, never stored.
  last_received_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The relay rule: a relay address's local part, current or in its rotation grace, names one mailbox.
CREATE UNIQUE INDEX IF NOT EXISTS email_mailboxes_relay_token_uniq
  ON email_mailboxes (relay_token);

CREATE UNIQUE INDEX IF NOT EXISTS email_mailboxes_previous_relay_token_uniq
  ON email_mailboxes (previous_relay_token)
  WHERE previous_relay_token IS NOT NULL;

-- A workspace's active mailboxes.
CREATE UNIQUE INDEX IF NOT EXISTS email_mailboxes_workspace_address_active_uniq
  ON email_mailboxes (workspace_id, address)
  WHERE removed_at IS NULL;

-- The direct rule must resolve an address to one mailbox, across workspaces.
CREATE UNIQUE INDEX IF NOT EXISTS email_mailboxes_address_active_uniq
  ON email_mailboxes (address)
  WHERE removed_at IS NULL;

-- Every policy a mailbox has had, so a delivery is judged by the policy in effect when the provider's
-- webhook was accepted. Version 1 is written with the mailbox; each later one with the mailbox's
-- `policy_version`, in the same transaction. Rows are never updated.
CREATE TABLE IF NOT EXISTS email_mailbox_policies (
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  engagement_mode TEXT NOT NULL CHECK (engagement_mode IN ('operator_only', 'draft', 'auto')),
  enabled BOOLEAN NOT NULL,
  agent_id UUID,
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by_user_id UUID,
  PRIMARY KEY (mailbox_id, version)
);

-- The policy effective at a moment: the newest row at or before it.
CREATE INDEX IF NOT EXISTS email_mailbox_policies_effective_idx
  ON email_mailbox_policies (mailbox_id, effective_at DESC);

-- One per email conversation: its identity, the latest header projection, the send budget and the
-- review schedule.
CREATE TABLE IF NOT EXISTS email_thread_links (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE RESTRICT,
  -- Not secret; carried in the conversation's channel context.
  thread_key UUID NOT NULL,
  -- The plus token, from at least 128 random bits.
  thread_token TEXT NOT NULL,
  participant_address TEXT NOT NULL CHECK (participant_address = lower(participant_address)),
  latest_subject TEXT,
  latest_participant_display_name TEXT,
  latest_cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  latest_inbound_at TIMESTAMPTZ,
  auto_sends_since_renewal INTEGER NOT NULL DEFAULT 0,
  budget_renewed_at TIMESTAMPTZ,
  -- Bumped by every review scheduled; completion clears the due time only for the revision it ran.
  review_revision INTEGER NOT NULL DEFAULT 0,
  review_completed_revision INTEGER NOT NULL DEFAULT 0,
  review_due_at TIMESTAMPTZ,
  review_lease_until TIMESTAMPTZ,
  review_attempts INTEGER NOT NULL DEFAULT 0,
  -- The accepted policy version of the newest delivery the pending review coalesces.
  review_policy_version INTEGER,
  -- One generation per revision.
  generation_reserved_revision INTEGER,
  review_last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_thread_links_thread_key_uniq
  ON email_thread_links (thread_key);

CREATE UNIQUE INDEX IF NOT EXISTS email_thread_links_thread_token_uniq
  ON email_thread_links (thread_token);

-- Thread resolution: a mailbox's threads with one participant.
CREATE INDEX IF NOT EXISTS email_thread_links_mailbox_participant_idx
  ON email_thread_links (mailbox_id, participant_address);

-- The review drain: threads with a review due.
CREATE INDEX IF NOT EXISTS email_thread_links_review_due_idx
  ON email_thread_links (review_due_at)
  WHERE review_due_at IS NOT NULL;

-- The committed thread index. `message_id` is null for a Message-Id only referenced, never seen.
CREATE TABLE IF NOT EXISTS email_thread_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'referenced')),
  origin TEXT NOT NULL CHECK (origin IN ('inbound', 'referenced', 'radioso_generated', 'provider_delivered')),
  rfc_message_id TEXT NOT NULL,
  subject TEXT,
  cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Foreign key added by 210, which creates email_inbound_deliveries.
  inbound_delivery_id UUID,
  -- Foreign key added by 216, which creates email_send_intents.
  send_intent_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_thread_messages_direction_origin_check CHECK (
    (direction = 'inbound' AND origin = 'inbound')
    OR (direction = 'referenced' AND origin = 'referenced')
    OR (direction = 'outbound' AND origin IN ('radioso_generated', 'provider_delivered'))
  )
);

-- A Message-Id is indexed once per mailbox; the same id in two mailboxes is two threads' business.
CREATE UNIQUE INDEX IF NOT EXISTS email_thread_messages_mailbox_rfc_message_id_uniq
  ON email_thread_messages (mailbox_id, rfc_message_id);

-- A conversation's thread, oldest first: the reply headers and the context window.
CREATE INDEX IF NOT EXISTS email_thread_messages_conversation_created_idx
  ON email_thread_messages (conversation_id, created_at);
