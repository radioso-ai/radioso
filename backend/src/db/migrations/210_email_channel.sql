-- The email channel's schema. A customer domain verified for sending (and, as an advanced option,
-- receiving); the mailboxes on it, with their current engagement policy and its append-only history;
-- per conversation, the thread link and the committed index of every RFC Message-Id seen, generated
-- or referenced for a mailbox; inbound mail, durable from the verified webhook to the conversation;
-- outbound mail, as fenced send intents; and two channel-neutral tables the channel writes and other
-- channels can: replies held for a teammate, and delivery failures raised on a conversation. The
-- relay domain is deployment configuration, not a row.
--
--   email_domains                   a domain verified for sending, and optionally receiving
--   email_mailboxes                 an address on a domain: its relay token, policy and budgets
--   email_mailbox_policies          every policy a mailbox has had
--   email_thread_links              one per email conversation: identity, headers, budget, review
--   email_inbound_events            one per verified provider webhook delivery
--   email_inbound_deliveries        one processing unit per event and mailbox
--   held_replies                    a reply waiting for a teammate before it reaches the customer
--   email_send_intents              one per attempt-chain that takes a message to the customer
--   email_thread_messages           the thread index: every Message-Id of a mailbox's thread
--   conversation_delivery_failures  a reply the customer may not have received
--
-- The tables are created in dependency order, so every foreign key is declared with its column.
--
-- Addresses and domains are stored lowercase, so the uniqueness below is case-insensitive by
-- construction. Thread tokens and relay tokens are secrets: they are never returned by an API or
-- written to a log.
--
-- Mailboxes and domains are removed by setting `removed_at`, never deleted, so history keeps its
-- references: deleting a domain or mailbox row that history still names is refused. Deleting the
-- workspace removes them, through its own cascade and its conversations'.
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

-- Inbound email, durably. `email_inbound_events` holds one row per verified provider webhook delivery
-- of any kind: the processing obligation the webhook leaves behind, deduplicated on the provider's
-- event id. `email_inbound_deliveries` holds one processing unit per event and mailbox: the mailbox
-- event log row, the holder of the message's content, and the thread-reservation log that lets a
-- follow-up and its parent find each other whichever is processed first. A delivery's planned
-- conversation, message and thread ids are reservations, not references, so they carry no foreign key.
--
-- A delivery's `workspace_id` is null only for mail to a relay token that was never issued. It
-- cascades from the workspace, so deleting a workspace removes every delivery attributed to it,
-- including mail that never reached a conversation: dropped mail, and mail to an unknown address on a
-- direct-receiving domain.
--
-- Envelopes, bodies and raw MIME are customer content: never logged.
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

-- Held replies: a reply an agent produced in review that waits for a teammate before it reaches the
-- customer. Channel-neutral and owned by handoff. The producing channel binds it to an opaque policy
-- (`policy_ref`, e.g. `email_mailbox:<uuid>`, at `policy_version`), the conversation's ownership
-- version, the customer message it answers and an idempotency ref (`review_ref`); handoff interprets
-- none of them beyond comparing versions.
--
--   pending      waiting for a teammate to release, edit and release, or discard it
--   queued_auto  queued for an automatic send, not yet authorized; never in operator attention
--   released     sent as the agent's message (`release_kind` operator, or auto once materialized)
--   edited       a teammate's edit sent as their message; the draft is kept beside the edit
--   discarded    a teammate set it aside; attention stays open until they reply or take over
--   superseded   a newer inbound, an operator reply, a takeover or a policy change replaced it
--
-- The draft (`draft_text`, `draft_presentation`) and an edit (`edited_text`) are customer content:
-- never logged, and never copied into `messages` except by an authorized release or materialization.
CREATE TABLE IF NOT EXISTS held_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- The author: the agent whose review turn produced the draft.
  agent_id UUID,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'queued_auto', 'released', 'edited', 'discarded', 'superseded')),
  release_kind TEXT CHECK (release_kind IN ('operator', 'auto')),
  -- The producer's idempotency ref for the review that produced it, e.g. `email:<conversationId>:<revision>`.
  review_ref TEXT,
  -- The customer message the draft answers: the inbound revision it is bound to, and the turn's
  -- request message.
  answers_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- The conversation's ownership version the review ran at; 0 when it had no ownership row.
  ownership_version INTEGER NOT NULL CHECK (ownership_version >= 0),
  policy_ref TEXT,
  policy_version INTEGER,
  -- The producer's code for why it was held; handoff never interprets it.
  hold_reason TEXT NOT NULL,
  -- The review turn's outcome, grounding, coverage and hand-off signal, as enum codes.
  turn_facts JSONB NOT NULL,
  -- The skill effects the review suppressed: `[{ "skillName": ... }]`.
  suppressed_effects JSONB NOT NULL DEFAULT '[]'::jsonb,
  draft_text TEXT NOT NULL,
  -- Host-owned presentation of the draft, written verbatim as the agent's message on release.
  draft_presentation JSONB NOT NULL,
  edited_text TEXT,
  -- The editor, the releaser and the teammate who discarded it, each recorded on their own.
  editor_user_id UUID,
  releaser_user_id UUID,
  discarded_by_user_id UUID,
  released_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  superseded_reason TEXT
    CHECK (superseded_reason IN ('newer_inbound', 'operator_reply', 'takeover', 'policy_changed')),
  attention_cleared_at TIMESTAMPTZ,
  attention_cleared_reason TEXT
    CHECK (attention_cleared_reason IN ('released', 'operator_reply', 'takeover', 'superseded')),
  decided_at TIMESTAMPTZ,
  -- To the millisecond, so the attention list's cursor carries it exactly through a JavaScript Date,
  -- and held replies created in one transaction tie on it and order by id.
  created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A policy is bound by its ref and version together, or not at all.
  CONSTRAINT held_replies_policy_check CHECK ((policy_ref IS NULL) = (policy_version IS NULL)),
  -- Only a sent held reply has a release kind; an edit is always a teammate's, and names its editor.
  CONSTRAINT held_replies_release_check CHECK (
    (state IN ('released', 'edited')) = (release_kind IS NOT NULL)
    AND (state <> 'edited' OR (release_kind = 'operator' AND edited_text IS NOT NULL AND editor_user_id IS NOT NULL))
    AND (release_kind IS DISTINCT FROM 'operator' OR releaser_user_id IS NOT NULL)
  ),
  CONSTRAINT held_replies_discard_check CHECK (state <> 'discarded' OR discarded_by_user_id IS NOT NULL),
  CONSTRAINT held_replies_superseded_check CHECK ((state = 'superseded') = (superseded_reason IS NOT NULL)),
  -- A live draft is undecided; every other held reply was decided.
  CONSTRAINT held_replies_decided_check CHECK ((state IN ('pending', 'queued_auto')) = (decided_at IS NULL)),
  -- Attention is open on a live draft, cleared on a sent or superseded one, and on a discarded one
  -- open until a teammate replies or takes over; a cleared one says why.
  CONSTRAINT held_replies_attention_check CHECK (
    (attention_cleared_at IS NULL) = (attention_cleared_reason IS NULL)
    AND (state NOT IN ('pending', 'queued_auto') OR attention_cleared_at IS NULL)
    AND (state NOT IN ('released', 'edited', 'superseded') OR attention_cleared_at IS NOT NULL)
  )
);

-- One live draft per conversation: the operator sees one current draft.
CREATE UNIQUE INDEX IF NOT EXISTS held_replies_live_conversation_uniq
  ON held_replies (conversation_id)
  WHERE state IN ('pending', 'queued_auto');

-- One held reply per review: holding a review's result again finds the first.
CREATE UNIQUE INDEX IF NOT EXISTS held_replies_review_ref_uniq
  ON held_replies (conversation_id, review_ref)
  WHERE review_ref IS NOT NULL;

-- The Inbox and Ray: a workspace's held replies waiting for a teammate, newest first.
CREATE INDEX IF NOT EXISTS held_replies_workspace_attention_idx
  ON held_replies (workspace_id, created_at)
  WHERE attention_cleared_at IS NULL AND state <> 'queued_auto';

-- A policy change supersedes the live drafts bound to the policy.
CREATE INDEX IF NOT EXISTS held_replies_live_policy_idx
  ON held_replies (policy_ref)
  WHERE state IN ('pending', 'queued_auto');

-- A conversation's held replies, newest first: its current draft, and its discarded drafts' attention.
CREATE INDEX IF NOT EXISTS held_replies_conversation_created_idx
  ON held_replies (conversation_id, created_at);

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
CREATE TABLE IF NOT EXISTS email_send_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  mailbox_id UUID NOT NULL REFERENCES email_mailboxes(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  -- The held reply this intent delivers. A held reply goes only with its conversation, which takes its
  -- intents with it, so the link clears rather than refusing whichever cascade runs first.
  held_reply_id UUID REFERENCES held_replies(id) ON DELETE SET NULL,
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
  -- The delivery that brought an inbound message in. A delivery removed by retention leaves the index
  -- row standing.
  inbound_delivery_id UUID REFERENCES email_inbound_deliveries(id) ON DELETE SET NULL,
  -- The send intent that took an outbound message out. An intent goes only with its message or
  -- conversation, which take the index row with them, so the link clears rather than refusing whichever
  -- cascade runs first.
  send_intent_id UUID REFERENCES email_send_intents(id) ON DELETE SET NULL,
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
