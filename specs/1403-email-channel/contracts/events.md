# Contract: Audit Events, Telemetry, Metrics, Alerts (1403 Email Channel)

## Redaction rule (FR-045), applies to every row below

No log line, metric label, span attribute, audit payload or telemetry property may contain:
- a subject, body, quoted text or draft text;
- an email address, display name, raw header value or relay or thread token;
- a provider bounce message, a prompt or a completion.

Allowed identifiers:
- workspace, conversation, mailbox, domain, delivery, send-intent and held-reply ids (uuid);
- provider event and message ids (opaque);
- enum values, counts and sizes in bytes;
- a hash of an idempotency key.

Domains (`customer.com`) are workspace configuration, not personal data. They may appear in audit payloads and settings logs, but never in metric labels (cardinality).

The `log` and `noop` mail drivers follow the same rule for `kind: "channel_reply"` (contracts/ports.md 1a).

## Audit events

They are recorded through the existing `AuditService`, using the `eventType` + `metadata.action` convention of `hitl.ownership` (`backend/src/modules/handoff/operatorReplyService.ts:110-122`).

| eventType | action | When | Metadata (ids and enums only) |
|---|---|---|---|
| `email_channel.domain` | `registered` | sending domain added (directly or by a mailbox) | domainId, domain, provider, region |
| `email_channel.domain` | `reconciliation_required` | the provider already holds a claimed domain; it waits for an operator's reconcile | domainId, domain, provider |
| `email_channel.domain` | `reconciled` | an operator adopted the provider's registration, or registered the domain afresh when the provider no longer held it | domainId, domain, provider, region, outcome (`adopted`/`registered`) |
| `email_channel.domain` | `readiness_changed` | sending or receiving status transition (FR-003) | domainId, capability (`sending`/`receiving`), from, to |
| `email_channel.domain` | `receiving_enabled` | advanced direct MX confirmed (FR-006a) | domainId, confirmedByUserId |
| `email_channel.domain` | `removed` | authority revoked (FR-006b) | domainId, haltedSendCount |
| `email_channel.mailbox` | `created` / `updated` / `removed` | mailbox lifecycle | mailboxId, domainId, agentId, changed field names |
| `email_channel.mailbox` | `mode_changed` | engagement mode or enabled change | mailboxId, fromMode, toMode, enabled, policyVersion, supersededHeldReplies |
| `email_channel.mailbox` | `relay_token_rotated` | rotation | mailboxId, graceExpiresAt |
| `email_channel.raw_message` | `viewed` | an operator opens a raw message (FR-046) | deliveryId, conversationId |
| `email_channel.event` | `retried` | an operator retries a failed inbound event | deliveryId |
| `hitl.held_reply` | `created` | review result held | heldReplyId, conversationId, holdReason, grounding, coverage, handoffRequested |
| `hitl.held_reply` | `released` | unchanged release (FR-028) | heldReplyId, conversationId, releaserUserId, messageId |
| `hitl.held_reply` | `edited_released` | edited release | heldReplyId, conversationId, editorUserId, releaserUserId, messageId |
| `hitl.held_reply` | `discarded` | discard | heldReplyId, conversationId, userId |
| `hitl.held_reply` | `superseded` | any supersede | heldReplyId, conversationId, reason |
| `hitl.held_reply` | `auto_queued` / `auto_materialized` / `auto_returned` | auto publish lifecycle (research B9) | heldReplyId, conversationId, code |
| `hitl.delivery_failure` | `opened` / `acknowledged` / `cleared` | delivery-failure lifecycle | failureId, conversationId, provider, kind, reason |
| `hitl.delivery_failure` | `resolved` | audited operator decision (FR-036) | failureId, sendIntentId, decision, userId |
| `hitl.delivery_failure` | `provider_evidence` | late provider evidence settles `uncertain` (research B18) | failureId, sendIntentId, to |
| `hitl.ownership` | `handoff_requested` | ingest with `operator_only_mailbox` / `generation_budget`; `review_unavailable` | conversationId, reason |

## Telemetry events

They use the existing `trackAssistantTurnCompleted` path for review turns, with `executionMode: "review"` and `surface: "email"`, plus these product events through the usage-event taxonomy (`docs/architecture/usage-event-taxonomy.md`):

| Event | Properties |
|---|---|
| `email_channel.mailbox_connected` | workspaceId, mailboxId, mode |
| `email_channel.setup_check_passed` | workspaceId, mailboxId, step, secondsToPass |
| `email_channel.held_reply_decided` | workspaceId, decision (`released`/`edited`/`discarded`), secondsPending |
| `email_channel.auto_reply_sent` | workspaceId, mailboxId |

## Metrics

Counters use `metricsRegistry.incrementCounter`, like `agentSkillTurnSkillProvider.ts:252`. Labels are bounded enums only, with no ids.

| Name | Type | Labels |
|---|---|---|
| `email_webhook_requests_total` | counter | `result` (`persisted`/`duplicate`/`bad_signature`/`stale_timestamp`/`malformed`/`db_unavailable`), `kind` |
| `email_webhook_ack_seconds` | histogram | `result` |
| `email_inbound_events_total` | counter | `kind`, `state` (`processed`/`failed`/`ignored`) |
| `email_inbound_deliveries_total` | counter | `classification`, `disposition`, `reason` |
| `email_inbound_fetch_attempts_total` | counter | `result` (`ok`/`retryable_error`/`terminal_error`) |
| `email_receipt_to_inbox_seconds` | histogram | `mode` (SC-008) |
| `email_receipt_to_held_reply_seconds` | histogram | none (SC-008) |
| `email_review_turns_total` | counter | `result` (`reply`/`no_reply`/`human_owned`/`error`), `grounding`, `coverage` |
| `email_reply_triage_total` | counter | `verdict` (`yes`/`no`/`unsure`/`unavailable`) |
| `email_completeness_checks_total` | counter | `verdict` (`complete`/`partial`/`not_answered`/`unavailable`) |
| `email_publication_decisions_total` | counter | `decision` (`publish`/`hold`/`no_reply`), `reason` |
| `email_budget_hits_total` | counter | `budget` (`thread_send`/`mailbox_generation`) |
| `email_send_intents_total` | counter | `trigger`, `state` |
| `email_send_provider_calls_total` | counter | `result` (`accepted`/`rejected`/`unknown`) |
| `email_domain_readiness_transitions_total` | counter | `capability`, `to` |
| `email_backlog` | gauge (sampled from the database by the API when `/metrics` is scraped, at most every 30 s) | `table`, `state`: `inbound_events` `pending`/`processing` received more than 10 min ago; `reviews_due` `due` more than 5 min ago; `send_intents` `queued` created more than 10 min ago. Counts only work past its deadline, so a draining queue reads 0. |
| `held_replies_total` | counter | `transition` (`created`/`released`/`edited`/`discarded`/`superseded`) |
| `agent_skill_effect_suppressed_total` | counter | `mode`, `site` (`turn`/`staged`). Added in S3 beside the unchanged `agent_skill_safe_test_dispatch_total`; R2 does not rename anything. |
| `email_drain_requests_total` | counter | `stage`, `scheduled` (`true`/`false`), `result` |
| `email_send_transition_conflicts_total` | counter | `writer` (`handler`/`webhook`/`reconciler`/`operator`). Fenced-transition retries (research B18). |

## OpenTelemetry spans

| Span | Where | Attributes |
|---|---|---|
| `email.webhook.verify` | email webhook | `radioso.email.provider`, `result` |
| `email.webhook.persist` | email webhook | `radioso.email.event_kind`, `duplicate` |
| `email.inbound.fetch` | inbound processor | `provider`, `attempt`, `result` |
| `email.inbound.normalize` | inbound processor | `raw_bytes`, `truncated`, `strip_confidence` |
| `email.inbound.thread_resolve` | inbound processor | `matched_by`, `conflict` |
| `email.inbound.disposition` | inbound processor | `classification`, `disposition`, `reason` |
| `email.review.turn` | review runner (wraps the chat turn span) | `radioso.conversation_id`, `radioso.workspace_id`, `execution_mode=review` |
| `email.review.reply_triage` | reply triage (`ModelEmailReplyTriage`) | `radioso.workspace_id`, `radioso.conversation_id`, `verdict` |
| `email.review.completeness` | completeness check (`ModelEmailReplyCompleteness`) | `radioso.workspace_id`, `radioso.conversation_id`, `verdict` |
| `email.review.publication` | review runner | `decision`, `reason` |
| `email.send.revalidate` | `EmailSendActionHandler` | `trigger`, `result` |
| `email.send.provider` | `EmailSendActionHandler` | `provider`, `result`, `attempt` |
| `email.domain.refresh` | domain service | `capability`, `result` |

Correlation: `radioso.workspace_id`, `radioso.conversation_id`, `radioso.email.delivery_id`, `radioso.email.send_intent_id`, `radioso.email.held_reply_id` on every span and structured log line of the flow.

## Structured logs (Pino)

These are emitted only on failure, skip or degradation paths, never per successful message:
- `email_inbound_fetch_failed` (code, attempt, retryable)
- `email_inbound_terminal_failure`
- `email_review_turn_failed`
- `email_reply_triaged` (info, ids and verdict only)
- `email_reply_triage_failed` (warn, ids only)
- `email_completeness_checked` (info, ids, verdict, unansweredAsks)
- `email_completeness_check_failed` (warn, ids only)
- `email_send_halted` (halt reason)
- `email_send_outcome_unknown`
- `email_send_uncertain`
- `email_send_idempotency_body_mismatch`
- `email_domain_readiness_lost`
- `email_channel_drain_push_failed` (warn, best-effort)

Every line carries ids and codes only.

## Alerts (`docs/monitoring-alerts.md` gains these)

| Alert | Condition | Severity |
|---|---|---|
| Inbound events stuck | `email_backlog{table="inbound_events",state="pending"} > 0` for 10 min (the gauge counts events received more than 10 min ago) | page |
| Reviews overdue | `email_backlog{table="reviews_due"} > 0` for 10 min (the gauge counts reviews due more than 5 min ago) | ticket |
| Webhook authentication failing | `email_webhook_requests_total{result=~"bad_signature\|stale_timestamp"}` above 5 in 5 min while no `persisted` | page (signing-key rotation or attack) |
| Uncertain sends accumulating | any `email_send_intents_total{state="uncertain"}` increase in 1 h | ticket |
| Domain readiness lost | `email_domain_readiness_transitions_total{capability="sending",to!="verified"}` from `verified` | ticket |
| Bounce spike | `email_send_intents_total{state="bounced"}` above 20% of `accepted` over 1 h with at least 20 sends | ticket |
| Idempotency body mismatch | any `email_send_idempotency_body_mismatch` | page (defect) |

## Runbooks (`docs/email-channel.md#operations`)

1. Provider outage: inbound and sends retry, and the backlog gauge grows. Nothing is dropped. After recovery, check `uncertain` intents.
2. Webhook signing-key rotation: set the new secret, accept both for 24 h, then remove the old one.
3. Stuck event replay: `POST …/email-channel/events/{deliveryId}/retry`, or the sweep's lease recovery.
4. Bounce spike: check the domain's readiness and per-record status, and pause `auto` mailboxes on the domain.
5. Events lost at the provider after more than 12 h of downtime: replay from the provider dashboard. Dedupe makes replays safe.
