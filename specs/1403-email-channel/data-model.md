# Data Model: Email Channel (1403)

**Date**: 2026-10-03, revised after the plan review | **Spec**: `specs/1403-email-channel/spec.md` | **Decisions**: `research.md` (B1–B20)

PostgreSQL 16 remains the system of record. Ten new tables. The only change to an existing table is one widening of `conversation_activity.kind`, done online in three committed phases, plus a replacement closing index (research B19). Conversations reuse `conversations.source_channel` (no CHECK, `197_conversation_caller_kind.sql:11`) and `conversations.channel_context`.

## Ownership by module

```text
backend/src/modules/emailChannel/          (channel keystone)
  email_domains ─┬─< email_mailboxes ─┬─< email_mailbox_policies (append-only)
                 │                    ├─< email_thread_links (1:1 conversation) ─< email_thread_messages
                 │                    ├─< email_inbound_deliveries >── email_inbound_events
                 │                    └─< email_send_intents (1:1 delivered message attempt-chain)
backend/src/modules/handoff/               (channel-neutral review)
  held_replies (n:1 conversation)
backend/src/modules/customerReplyDelivery/ (channel-neutral delivery attention)
  conversation_delivery_failures (n:1 conversation)
```

Tables beyond the spec's entity list, with the requirement behind each:
- `email_inbound_deliveries` (FR-009): per-mailbox processing, separate from provider-event dedupe. It is also the durable thread-reservation log (B15).
- `email_mailbox_policies` (FR-025): policy effective at acceptance (B16).
- `conversation_delivery_failures` (FR-040): `delivery_failed` is a shared kind.

The review queue and the generation counter are columns, not tables.

---

## `email_domains`

A customer-owned domain verified for sending on behalf of one workspace. Its receiving readiness is used only by the advanced direct-receiving option (B20). The relay domain is deployment configuration, not a row.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `workspace_id` | uuid | no | FK `workspaces(id)` ON DELETE CASCADE |
| `domain` | text | no | lowercase IDNA A-label; CHECK `domain = lower(domain)` |
| `provider` | text | no | CHECK IN (`resend`, `local`) |
| `provider_domain_id` | text | yes | |
| `provider_region` | text | yes | |
| `dns_records` | jsonb | no | default `'[]'`; `DnsRecordView[]` |
| `sending_status` | text | no | default `pending`; CHECK IN (`pending`,`verified`,`failed`) |
| `receiving_status` | text | no | default `not_requested`; CHECK IN (`not_requested`,`pending`,`verified`,`failed`) |
| `receiving_confirmed_by_user_id` | uuid | yes | typed confirmation (FR-006a) |
| `receiving_confirmed_at` | timestamptz | yes | |
| `last_checked_at`, `next_check_at`, `status_changed_at` | timestamptz | yes | refresh cadence |
| `removed_at` | timestamptz | yes | authority revoked first; history kept (FR-006b) |
| `provider_cleanup_status` | text | yes | CHECK IN (`pending`,`done`,`failed`) |
| `created_by_user_id` | uuid | yes | |
| `created_at`, `updated_at` | timestamptz | no | default `now()` |

- Unique: `email_domains_active_domain_uniq` ON (`domain`) WHERE `removed_at IS NULL` (FR-003).
- Indexes: (`workspace_id`); (`next_check_at`) WHERE `removed_at IS NULL`; (`domain`) WHERE `receiving_status = 'verified' AND removed_at IS NULL` (direct-rule lookup).

`DnsRecordView`: `{ purpose: "dkim" | "spf" | "return_path" | "receiving_mx" | "dmarc", type: "TXT" | "MX" | "CNAME", name, value, priority?, status: "pending" | "verified" | "failed" | "advisory" }`.

## `email_mailboxes`

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `workspace_id` | uuid | no | FK `workspaces(id)` ON DELETE CASCADE |
| `domain_id` | uuid | no | FK `email_domains(id)` ON DELETE RESTRICT |
| `agent_id` | uuid | yes | FK `agents(id)` ON DELETE SET NULL; null behaves as `operator_only` |
| `address` | text | no | lowercase `local@domain`; immutable |
| `display_name` | text | no | |
| `relay_token` | text | no | 26-character base32, from 128+ bits |
| `previous_relay_token`, `previous_relay_token_expires_at` | text, timestamptz | yes | rotation grace (7 days) |
| `engagement_mode` | text | no | current policy; default chosen by the service (plan, Questions settled, item 4); CHECK IN (`operator_only`,`draft`,`auto`) |
| `enabled` | boolean | no | default `true` |
| `policy_version` | integer | no | default 1; bumped with every `email_mailbox_policies` row |
| `thread_send_budget` | integer | no | default 3; CHECK BETWEEN 1 AND 20 |
| `hourly_generation_budget` | integer | no | default 30; CHECK BETWEEN 1 AND 1000 |
| `generation_window_started_at` | timestamptz | yes | |
| `generation_window_count` | integer | no | default 0 |
| `thread_context_messages` | integer | no | default 10; CHECK BETWEEN 1 AND 50 |
| `spam_opt_in` | boolean | no | default `false` |
| `silence_threshold_hours` | integer | no | default 72; CHECK BETWEEN 1 AND 2160 |
| `plus_address_verified_at` | timestamptz | yes | |
| `setup_check_step`, `setup_check_started_at` | text, timestamptz | yes | step CHECK IN (`base`,`plus_address`) |
| `last_received_at` | timestamptz | yes | |
| `removed_at` | timestamptz | yes | |
| `created_by_user_id` | uuid | yes | |
| `created_at`, `updated_at` | timestamptz | no | |

- Unique: (`relay_token`); (`previous_relay_token`) WHERE NOT NULL; (`workspace_id`, `address`) WHERE `removed_at IS NULL`; (`address`) WHERE `removed_at IS NULL` (direct-rule lookup must be unambiguous).
- The service checks that `address`'s domain equals the domain of `domain_id`; a unit test covers this.
- Receiving state is derived, never stored (see State machines).

## `email_mailbox_policies` (append-only, B16)

| Column | Type | Null | Notes |
|---|---|---|---|
| `mailbox_id` | uuid | no | FK `email_mailboxes(id)` ON DELETE CASCADE |
| `version` | integer | no | |
| `engagement_mode` | text | no | CHECK IN (`operator_only`,`draft`,`auto`) |
| `enabled` | boolean | no | |
| `agent_id` | uuid | yes | |
| `effective_at` | timestamptz | no | default `now()` |
| `changed_by_user_id` | uuid | yes | |

- PK (`mailbox_id`, `version`). Index (`mailbox_id`, `effective_at` DESC).
- Version 1 is written with the mailbox. Every later row is written by `MailboxPolicyChangeUnitOfWork` together with the mailbox's `policy_version`.

## `email_inbound_events`

One row per verified provider webhook delivery of any kind. It is the stage-1 processing obligation.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `provider` | text | no | |
| `provider_event_id` | text | no | `svix-id` |
| `event_kind` | text | no | CHECK IN (`message_received`,`delivery_status`,`domain_status`,`unsupported`) |
| `provider_object_id` | text | yes | |
| `envelope` | jsonb | no | verified webhook metadata; never logged |
| `state` | text | no | default `pending`; CHECK IN (`pending`,`processing`,`processed`,`failed`,`ignored`) |
| `attempts` | integer | no | default 0 |
| `next_attempt_at` | timestamptz | no | default `now()` |
| `lease_until` | timestamptz | yes | |
| `last_error_code` | text | yes | |
| `received_at` | timestamptz | no | default `now()`; the acceptance time for B16 |
| `processed_at` | timestamptz | yes | |

- Unique: (`provider`, `provider_event_id`); (`provider`, `provider_object_id`) WHERE `event_kind = 'message_received'`.
- Index: (`next_attempt_at`) WHERE `state IN ('pending','processing')`.

## `email_inbound_deliveries`

One processing unit per (event, mailbox). It is the event-log row, the raw-content holder and the thread-reservation log (B15).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `inbound_event_id` | uuid | no | FK `email_inbound_events(id)` ON DELETE CASCADE |
| `workspace_id` | uuid | yes | null only for a never-issued relay token |
| `mailbox_id` | uuid | yes | FK `email_mailboxes(id)` ON DELETE RESTRICT |
| `route_rule` | text | yes | CHECK IN (`relay`,`direct`) (B20) |
| `accepted_policy_version` | integer | yes | effective at `email_inbound_events.received_at` (B16) |
| `state` | text | no | default `pending`; CHECK IN (`pending`,`fetched`,`resolved`,`ingested`,`done`,`failed`) |
| `classification` | text | yes | CHECK IN (`person`,`automated_sender`,`bounce`,`self_sender`,`spam`) |
| `disposition` | text | yes | CHECK IN (`ingest_only`,`run_review_turn`,`drop`) |
| `disposition_reason` | text | yes | CHECK IN (`no_mailbox`,`mailbox_disabled`,`automated_sender`,`self_sender`,`bounce`,`spam`,`participant_mismatch`,`operator_only_mailbox`,`human_owned`,`generation_budget`,`spam_opt_in`,`no_agent`,`accepted`) |
| `sender_address`, `sender_display_name`, `subject` | text | yes | |
| `rfc_message_id` | text | yes | |
| `reference_ids` | text[] | no | default `'{}'`; `References` ∪ `In-Reply-To`, normalized |
| `cc_addresses`, `received_for` | text[] | no | default `'{}'` |
| `auth_results` | jsonb | no | default `'{}'` |
| `spam_verdict` | text | no | default `unknown`; CHECK IN (`spam`,`not_spam`,`unknown`) |
| `attachments` | jsonb | no | default `'[]'` |
| `body_text` | text | yes | |
| `strip_confidence` | text | yes | CHECK IN (`confident`,`full_text`) |
| `raw_mime` | bytea | yes | capped (B10) |
| `raw_size_bytes` | integer | yes | |
| `raw_truncated` | boolean | no | default `false` |
| `thread_match` | text | yes | CHECK IN (`in_reply_to`,`references`,`reverse_reference`,`thread_token`,`new_thread`) |
| `thread_conflict` | boolean | no | default `false` |
| `planned_conversation_id` | uuid | yes | reservation (no FK; B15) |
| `planned_message_id` | uuid | yes | reservation (no FK) |
| `planned_thread_key`, `planned_thread_token` | uuid, text | yes | for a new thread |
| `conversation_id` | uuid | yes | FK `conversations(id)` ON DELETE CASCADE; set after ingest |
| `message_id` | uuid | yes | FK `messages(id)` ON DELETE SET NULL |
| `last_error_code` | text | yes | |
| `created_at` | timestamptz | no | |
| `processed_at` | timestamptz | yes | |

- Unique: (`inbound_event_id`, `mailbox_id`) WHERE `mailbox_id IS NOT NULL`; (`inbound_event_id`) WHERE `mailbox_id IS NULL`.
- Indexes:
  - (`mailbox_id`, `created_at` DESC): event log;
  - (`workspace_id`, `created_at` DESC);
  - (`created_at`) WHERE `conversation_id IS NULL`: retention;
  - (`mailbox_id`, `rfc_message_id`) WHERE `state IN ('resolved','ingested','done')`: forward reservation lookup;
  - GIN (`reference_ids`): reverse lookup, filtered by `mailbox_id`.

## `email_thread_links`

One per email conversation: identity, latest header projection, send budget and the review schedule (B7, B17).

| Column | Type | Null | Notes |
|---|---|---|---|
| `conversation_id` | uuid | no | PK; FK `conversations(id)` ON DELETE CASCADE |
| `workspace_id` | uuid | no | |
| `mailbox_id` | uuid | no | FK `email_mailboxes(id)` ON DELETE RESTRICT |
| `thread_key` | uuid | no | non-secret; in channel context |
| `thread_token` | text | no | plus token, 128+ bits; never in APIs or logs |
| `participant_address` | text | no | lowercase |
| `latest_subject`, `latest_participant_display_name` | text | yes | |
| `latest_cc_addresses` | text[] | no | default `'{}'` |
| `latest_inbound_at` | timestamptz | yes | |
| `auto_sends_since_renewal` | integer | no | default 0 |
| `budget_renewed_at` | timestamptz | yes | |
| `review_revision` | integer | no | default 0 |
| `review_completed_revision` | integer | no | default 0 |
| `review_due_at` | timestamptz | yes | |
| `review_lease_until` | timestamptz | yes | |
| `review_attempts` | integer | no | default 0 |
| `review_policy_version` | integer | yes | accepted version of the newest coalesced delivery (B16) |
| `generation_reserved_revision` | integer | yes | one generation per revision (B8) |
| `review_last_error_code` | text | yes | |
| `created_at`, `updated_at` | timestamptz | no | |

- Unique: (`thread_key`); (`thread_token`).
- Indexes: (`mailbox_id`, `participant_address`); (`review_due_at`) WHERE `review_due_at IS NOT NULL`.

## `email_thread_messages`

The committed thread index: every RFC Message-Id seen, generated or referenced for a mailbox.

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `workspace_id` | uuid | no | |
| `mailbox_id` | uuid | no | FK `email_mailboxes(id)` ON DELETE RESTRICT |
| `conversation_id` | uuid | no | FK `conversations(id)` ON DELETE CASCADE |
| `message_id` | uuid | yes | FK `messages(id)` ON DELETE CASCADE; null for `referenced` |
| `direction` | text | no | CHECK IN (`inbound`,`outbound`,`referenced`) |
| `origin` | text | no | CHECK IN (`inbound`,`referenced`,`radioso_generated`,`provider_delivered`) |
| `rfc_message_id` | text | no | |
| `subject` | text | yes | |
| `cc_addresses` | text[] | no | default `'{}'` |
| `attachments` | jsonb | no | default `'[]'` |
| `inbound_delivery_id` | uuid | yes | FK added in **210** (table created there) |
| `send_intent_id` | uuid | yes | FK added in **216** (table created there) |
| `created_at` | timestamptz | no | |

- Unique: (`mailbox_id`, `rfc_message_id`).
- CHECK: (`direction`, `origin`) ∈ {(`inbound`,`inbound`), (`referenced`,`referenced`), (`outbound`,`radioso_generated`), (`outbound`,`provider_delivered`)}.
- Index: (`conversation_id`, `created_at`).

## `email_send_intents`

One per outbound send attempt-chain. It always references a written message (B6, B9).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `workspace_id` | uuid | no | |
| `mailbox_id` | uuid | no | FK `email_mailboxes(id)` ON DELETE RESTRICT |
| `conversation_id` | uuid | no | FK `conversations(id)` ON DELETE CASCADE |
| `message_id` | uuid | no | FK `messages(id)` ON DELETE CASCADE |
| `held_reply_id` | uuid | yes | FK added in **218** |
| `idempotency_key` | text | no | unique; equals the outbox key; at most 256 characters |
| `author_kind` | text | no | CHECK IN (`agent`,`operator`) |
| `trigger` | text | no | CHECK IN (`operator_reply`,`held_release`,`auto_reply`,`audited_resend`) |
| `state` | text | no | default `queued`; CHECK IN (`queued`,`accepted`,`delivered`,`bounced`,`failed`,`uncertain`,`halted`) |
| `version` | integer | no | default 0; fence for every writer (B18) |
| `halt_reason` | text | yes | CHECK IN (`sending_not_verified`,`domain_removed`,`mailbox_removed`) |
| `authority_snapshot` | jsonb | no | |
| `request_snapshot` | jsonb | yes | frozen on first attempt; body nulled when terminal |
| `provider` | text | no | |
| `provider_message_id` | text | yes | |
| `supplied_rfc_message_id` | text | no | |
| `delivered_rfc_message_id` | text | yes | |
| `first_attempt_at`, `outcome_unknown_since` | timestamptz | yes | |
| `next_reconcile_at`, `reconcile_lease_until` | timestamptz | yes | claimed reconciliation (B18) |
| `accepted_at`, `settled_at`, `complained_at` | timestamptz | yes | |
| `failure_code` | text | yes | sanitized |
| `uncertain_resolution` | text | yes | CHECK IN (`provider_evidence`,`marked_sent`,`resend_authorized`) |
| `uncertain_resolved_by_user_id` | uuid | yes | |
| `created_at`, `updated_at` | timestamptz | no | |

- Unique: (`idempotency_key`); (`provider`, `provider_message_id`) WHERE NOT NULL.
- Indexes: (`message_id`); (`next_reconcile_at`) WHERE `state IN ('queued','accepted','uncertain') AND next_reconcile_at IS NOT NULL`; (`mailbox_id`, `state`).

## `held_replies` (handoff, channel-neutral)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `workspace_id` | uuid | no | |
| `conversation_id` | uuid | no | FK `conversations(id)` ON DELETE CASCADE |
| `agent_id` | uuid | yes | |
| `state` | text | no | default `pending`; CHECK IN (`pending`,`queued_auto`,`released`,`edited`,`discarded`,`superseded`) |
| `release_kind` | text | yes | CHECK IN (`operator`,`auto`) |
| `review_ref` | text | yes | producer idempotency ref (B17) |
| `answers_message_id` | uuid | no | FK `messages(id)` ON DELETE CASCADE |
| `ownership_version` | integer | no | bound version (0 when no ownership row) |
| `policy_ref` | text | yes | opaque (`email_mailbox:<uuid>`) |
| `policy_version` | integer | yes | bound version |
| `hold_reason` | text | no | producer code; no CHECK |
| `turn_facts` | jsonb | no | `ConnectorTurnFacts` |
| `suppressed_effects` | jsonb | no | default `'[]'` |
| `draft_text` | text | no | |
| `draft_presentation` | jsonb | no | host-owned presentation, written verbatim on materialization |
| `edited_text` | text | yes | |
| `editor_user_id`, `releaser_user_id`, `discarded_by_user_id` | uuid | yes | author, editor and releaser recorded separately (FR-028) |
| `released_message_id` | uuid | yes | FK `messages(id)` ON DELETE SET NULL |
| `superseded_reason` | text | yes | CHECK IN (`newer_inbound`,`operator_reply`,`takeover`,`policy_changed`) |
| `attention_cleared_at` | timestamptz | yes | |
| `attention_cleared_reason` | text | yes | CHECK IN (`released`,`operator_reply`,`takeover`,`superseded`) |
| `decided_at`, `created_at`, `updated_at` | timestamptz | | |

- Unique: (`conversation_id`) WHERE `state IN ('pending','queued_auto')`, so there is one live draft per conversation; (`conversation_id`, `review_ref`) WHERE `review_ref IS NOT NULL`.
- Indexes: (`workspace_id`, `created_at`) WHERE `attention_cleared_at IS NULL AND state <> 'queued_auto'`; (`policy_ref`) WHERE `state IN ('pending','queued_auto')`.
- Held content (`draft_text`, `edited_text`) is never copied into `messages` except by an authorized release or materialization (B9).

## `conversation_delivery_failures` (customerReplyDelivery, channel-neutral)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid | no | PK |
| `workspace_id` | uuid | no | |
| `conversation_id` | uuid | no | FK `conversations(id)` ON DELETE CASCADE |
| `message_id` | uuid | yes | FK `messages(id)` ON DELETE CASCADE |
| `provider` | text | no | |
| `failure_kind` | text | no | CHECK IN (`bounced`,`failed`,`uncertain`,`halted`) |
| `detail_code` | text | yes | sanitized |
| `opened_at` | timestamptz | no | |
| `cleared_at` | timestamptz | yes | |
| `cleared_by_user_id` | uuid | yes | |
| `clear_reason` | text | yes | CHECK IN (`acknowledged`,`later_delivery`,`provider_evidence`,`operator_resolved`) |

- Unique: (`conversation_id`, `message_id`) WHERE `cleared_at IS NULL`.
- Index: (`workspace_id`, `opened_at`) WHERE `cleared_at IS NULL`.

## `conversation_activity` (existing; widened once, research B19)

- New kinds: `channel_exception`, `delivery_failed`, `delivery_failure_cleared`, `held_reply_released`, `held_reply_discarded`.
- New closing kinds: `held_reply_released`, `delivery_failure_cleared`.
- `channel_exception` carries `detail: { code: "participant_mismatch" | "automated_sender" | "thread_conflict" | "no_reply_needed", deliveryId }`.
- The replacement closing index `conversation_activity_workspace_closed_v2_idx` extends the predicate of `205_conversation_activity.sql:50-52`.

---

## `email` channel context JSON

```ts
type EmailChannelContext = {
  provider: "email";
  mailbox: { id: string; address: string };
  threadKey: string;
  participant: { address: string };
};
```

---

## State machines

### Held reply

| State | Event | Next | Side effects |
|---|---|---|---|
| (none) | review result, decision `hold`, policy and ownership still bound, latest message | `pending` | `approval`; audit `created` |
| (none) | as above but bound version stale or a newer customer message | `superseded` | review rescheduled |
| (none) | decision `publish`, `queueAuto` succeeds (B9) | `queued_auto` | send budget reserved; `email.send` (`email:send:held:<id>`) |
| (none) | decision `publish`, `queueAuto` refused (stale policy or ownership, budget) | `pending` | hold reason `authority_changed` or `send_budget` |
| `queued_auto` | materialize authorized | `released` (`release_kind auto`) | agent message + send intent written together |
| `queued_auto` | materialize not authorized | `pending` | hold reason `authority_changed`; `approval`; no message |
| `queued_auto` | policy change `auto` → `draft`, nothing else changed (`return_queued`, `policy_changed`) | `pending` | hold reason `policy_changed`; re-bound to the new `policy_version`; `approval` stays open; no message; no review scheduled; its `email.send` materializes nothing (`not_queued`) |
| `pending` | policy change `auto` → `draft`, nothing else changed (`rebind_policy`) | `pending` | hold reason kept; re-bound to the new `policy_version`, so a later release passes `lockPolicy` |
| `pending` | operator release, unchanged (state, ownership and policy all current) | `released` (`operator`) | agent message; `email.send` (`msg:` key); activity `held_reply_released`; audit names releaser |
| `pending` | operator release, edited | `edited` | operator message from `edited_text`; original retained; audit names editor and releaser |
| `pending` | discard | `discarded` | attention stays open; activity `held_reply_discarded` |
| `discarded` | operator reply or takeover | `discarded` | `attention_cleared_at` set |
| `pending`, `queued_auto` | newer inbound, operator reply, takeover or transfer, any other policy change (to `operator_only`, disable, agent change, upgrade) | `superseded` (reason) | |
| `released`, `edited`, `superseded`, `discarded` | release, discard or materialize | unchanged | conditional update matches nothing → `409 held_reply_not_pending` |

### Send intent (every transition fenced on `version`, B18)

| State | Event | Next | Side effects |
|---|---|---|---|
| (none) | handler first claim (operator triggers) or materialize (auto) | `queued` | |
| `queued` | first-attempt revalidation fails (operator triggers) | `halted` | `delivery_failed` (`halted`); resend only through audited resolution |
| `queued` | provider accepted | `accepted` | ids recorded; `next_reconcile_at = now() + 24h` |
| `queued` | definite rejection | `failed` | `delivery_failed` |
| `queued` | unknown outcome, authority still valid, inside `first_attempt_at + 23h` | `queued` | `outcome_unknown_since`; scheduled re-POST, same key and same snapshot |
| `queued` | unknown outcome and authority since revoked, or past the window | `uncertain` | `delivery_failed` (`uncertain`); never re-POSTed |
| `accepted` | delivered (event or lookup) | `delivered` | clears an open failure (`later_delivery`) |
| `accepted` | bounced or suppressed (event, lookup or inbound DSN) | `bounced` | `delivery_failed` |
| `accepted` | failed | `failed` | `delivery_failed` |
| `accepted` | reconcile lookup cannot settle | `uncertain` | `delivery_failed` |
| `uncertain` | late provider evidence: delivered | `delivered` | resolution `provider_evidence`; failure cleared |
| `uncertain` | late provider evidence: bounced or failed | `bounced` / `failed` | resolution `provider_evidence`; failure retargeted |
| `uncertain` | operator `marked_sent` | `uncertain` (resolved) | audit; failure cleared `operator_resolved` |
| `uncertain`, `halted` | operator `resend` (audited) | unchanged (resolved) | new intent under `…:resend:<n>` |
| terminal | any later event | unchanged | metric only |

### Sending domain (receiving is identical over `receiving_status`)

| State | Event | Next | Side effects |
|---|---|---|---|
| (none) | registered | `pending` | audit `registered` |
| `pending` | provider verified | `verified` | mailboxes report `sending: ok`; audit |
| `pending` | provider failed | `failed` | audit |
| `verified` | refresh not verified | `pending` / `failed` | first-attempt sends halt; card flags; alert |
| any | removal | `removed_at` set | authority revoked first; cleanup async |

### Mailbox receiving (derived)

| State | Condition |
|---|---|
| `waiting_for_first_message` | `last_received_at IS NULL` |
| `ok` | received within `silence_threshold_hours` |
| `silent` | older than the threshold |

### Inbound processing

| Unit | State | Event | Next |
|---|---|---|---|
| event | `pending` | claimed | `processing` |
| event | `processing` | fetched; deliveries inserted with `route_rule` and `accepted_policy_version` | `processing` |
| event | `processing` | all deliveries `done` | `processed` |
| event | `processing` | not ours | `ignored` |
| event | `processing` | retries exhausted | `failed` |
| delivery | `pending` | normalized and classified | `fetched` |
| delivery | `fetched` | disposition `drop` | `done` (+ `channel_exception` when a thread exists) |
| delivery | `fetched` | thread resolved and reserved (B15 step 1) | `resolved` |
| delivery | `resolved` | `ingest` committed | `ingested` |
| delivery | `ingested` | link and index written; review scheduled when needed | `done` |

### Review schedule (per thread link, B17)

| Event | Effect |
|---|---|
| `run_review_turn` disposition | `review_revision += 1`; `review_due_at = COALESCE(review_due_at, now + window)`; `review_policy_version` set; drain scheduled at `review_due_at` |
| claim | `review_lease_until = now + lease` for revision R |
| hold or queue with `review_ref` R exists | no second turn |
| complete | clears due and lease only `WHERE review_revision = R` |
| retryable failure | `review_attempts += 1`; due time pushed by backoff; drain scheduled |
| terminal failure | `review_unavailable` hand-off; completion as above |

---

## Migrations

Numbers continue from `208_test_execution_seed_summary_backfill.sql` and are renumbered at merge time if `main` moves. Every FK targets a table that already exists when its migration runs. Forward references are added in the migration that creates the target table.

| # | File | Purpose | FKs added here | Slice |
|---|---|---|---|---|
| 209 | `209_email_channel_keystone.sql` | `email_domains`, `email_mailboxes`, `email_mailbox_policies`, `email_thread_links`, `email_thread_messages` (no FK on `inbound_delivery_id` / `send_intent_id` yet) | to `workspaces`, `agents`, `conversations`, `messages` and the new keystone tables | S1 |
| 210 | `210_email_inbound_events.sql` | `email_inbound_events`, `email_inbound_deliveries` | `email_thread_messages.inbound_delivery_id → email_inbound_deliveries` | S1 |
| 211 | `211_conversation_activity_kind_v2_add.sql` | `SET LOCAL lock_timeout='3s'`; `ADD CONSTRAINT conversation_activity_kind_v2_check … NOT VALID` with every kind this feature needs | none | S1 |
| 212 | `212_conversation_activity_kind_v2_validate.sql` | `VALIDATE CONSTRAINT conversation_activity_kind_v2_check` | none | S1 |
| 213 | `213_conversation_activity_kind_drop_v1.sql` | `SET LOCAL lock_timeout='3s'`; `DROP CONSTRAINT conversation_activity_kind_check` | none | S1 |
| 214 | `214_conversation_activity_closed_idx_v2.sql` | `SET LOCAL lock_timeout='3s'`; `CREATE INDEX IF NOT EXISTS conversation_activity_workspace_closed_v2_idx … WHERE kind IN (… + 'held_reply_released','delivery_failure_cleared')` (pre-create `CONCURRENTLY` per runbook when large) | none | S1 |
| 215 | `215_conversation_delivery_failures.sql` | `conversation_delivery_failures` | to `conversations`, `messages` | S2 |
| 216 | `216_email_send_intents.sql` | `email_send_intents` | `email_thread_messages.send_intent_id → email_send_intents` | S2 |
| 217 | `217_conversation_activity_closed_idx_v1_drop.sql` | `SET LOCAL lock_timeout='3s'`; `DROP INDEX IF EXISTS conversation_activity_workspace_closed_idx` (after S1's query switch is deployed everywhere) | none | S2 |
| 218 | `218_held_replies.sql` | `held_replies` | `email_send_intents.held_reply_id → held_replies` | S3 |

That makes ten migration files, one activity widening done in three phases, and one index replacement.

## Generated artifacts

- `backend/src/shared/infra/kysely/schema.ts`: regenerated with `cd backend && pnpm run db:types` after each migration.
- `backend/src/db/schema.sql`: regenerated with `cd backend && pnpm run db:schema`, checked with `db:schema:check`.
- Both are committed with each migration. Neither is hand-edited.
