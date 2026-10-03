# Research and Design Decisions: Email Channel (1403)

**Date**: 2026-10-03 | **Spec**: `specs/1403-email-channel/spec.md` | **Plan**: `specs/1403-email-channel/plan.md`

Phase 0 output. Part A verifies every assumption the spec marks "plan MUST verify". Part B records the architecture decisions the plan builds on. Paths are repo-relative; line numbers are as of `609be74e7`. Anything not confirmed from primary documentation is marked **UNVERIFIED** and carried into the Phase 0 spike (plan, Phase ordering, slice S0).

---

## Part A: Provider and protocol verification

### A1. Resend inbound webhooks and content fetch

- **Decision**: Receive on the deployment's relay domain through Resend Receiving. The `email.received` webhook carries metadata only. The inbound worker fetches the message with `GET /emails/receiving/{id}`, downloads the raw MIME from `raw.download_url`, and stores the bytes. Normalization parses the raw MIME itself (A11) rather than trusting Resend's parsed `text`/`html`/`headers`, so every adapter, including the `local` one, yields the same `InboundEmailMessage`.
- **Rationale**: The webhook contains no body or headers, so content fetch has to be a separate retryable step. That is what FR-007/FR-008 require anyway. Raw MIME is the only reliable source for DSN structure, RFC 3834 headers, the attachments manifest, and FR-013's rule that the stored raw body is the content itself, not a link.
- **Alternatives considered**: (a) Use Resend's parsed `headers` object. Rejected because the documented example names only `from`, `return-path`, `mime-version`; whether `In-Reply-To`, `References`, `Auto-Submitted`, `Delivered-To` appear is UNVERIFIED, and DSN parts are not exposed. (b) Fetch inline in the webhook. Rejected by the spec's durability rule.
- **Evidence**: https://resend.com/docs/webhooks/emails/received ("Webhooks do not include the email body, headers, or attachments, only their metadata"); https://resend.com/docs/api-reference/emails/retrieve-received-email (`raw.download_url` + `expires_at`, `authentication` with SPF/DKIM/DMARC values `pass|fail|gray|processing_failed|unknown`, `received_for`, `message_id`, attachments metadata).
- **Open risk**: How long Resend keeps received emails fetchable is undocumented, so the inbound retry budget is bounded to hours, not days. The signed raw URL expires, so every attempt re-reads the email record for a fresh URL. Rate limits on the receiving API are undocumented, so the inbound drain queue runs at low concurrency (plan, Message-Queue Impact). Resend exposes **no spam verdict**, so the Resend adapter always reports `unknown`, which FR-015 treats as not spam. The `spam` disposition exists in the port for other providers and is exercised only by fixtures.

### A2. Which address identifies the mailbox (delivered-to)

- **Decision**: The *delivered-to set* is `received_for` ∪ raw `Delivered-To` / `X-Original-To` ∪ `to` / `cc`, filtered structurally to addresses whose domain equals `EMAIL_CHANNEL_INBOUND_DOMAIN`. The relay token is the local part of such an address. On the default path the mailbox is resolved only from a relay token, and an address on a customer domain never resolves a mailbox. The one exception is the advanced direct-receiving option (B20), where the customer has pointed that domain's MX at the provider. Distinct mailboxes in one event fan out to one processing unit per mailbox (FR-009).
- **Rationale**: For forwarded mail Resend's `to` is the header `To` (`support@customer.com`). `received_for` is documented as "the recipient addresses the email was forwarded for, taken from the `for` clause of the message's `Received` headers", which is exactly the relay hop. Restricting the match to the configured inbound domain satisfies the anti-goal "do not resolve the mailbox from the `To` header": a `To` address only ever counts when it *is* a relay address, as in a forwarding-confirmation email sent straight to the relay.
- **Alternatives considered**: One receiving subdomain per mailbox (DNS work per mailbox, rejected). Routing by the customer address in `To` (anti-goal, rejected).
- **Evidence**: https://resend.com/docs/webhooks/emails/received (`received_for` definition); https://resend.com/docs/dashboard/receiving/introduction (domain catch-all: "You will receive emails sent to any address at your Resend domain").
- **Open risk**: UNVERIFIED whether Google Workspace and Microsoft 365 forwarders add a `for <relay>` clause. Resend's own receiving MTA normally stamps `Received: ... for <rcpt>`, which should populate `received_for` regardless. The S0 spike forwards from a real Workspace and M365 tenant and commits the resulting payloads as fixtures. If neither source carries the relay address, the fallback is the raw `Delivered-To` stamped by Resend, which the spike also checks.

### A3. Webhook signing, retries, dedupe

- **Decision**: Verify Svix/Standard Webhooks signatures inside the Resend receiver adapter with `node:crypto`. The algorithm is HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}` with the base64 key after the `whsec_` prefix. `svix-signature` holds space-delimited `v1,<sig>` entries, compared in constant time, with a ±5 minute timestamp tolerance. Dedupe on `(provider, svix-id)`, and for `email.received` also on `(provider, data.email_id)`.
- **Rationale**: This is the same constant-time HMAC pattern as the Slack and WhatsApp webhooks (`backend/src/modules/connectors/plugins/whatsapp/whatsappWebhook.ts`, `slackWebhook.ts`) and needs no new dependency. Resend retries at roughly immediate, 5 s, 5 min, 30 min, 2 h and 10 h, so delivery is at-least-once and dedupe is mandatory.
- **Alternatives considered**: The `svix` or `resend` SDK. Rejected: `resend` is not a backend dependency (`backend/src/modules/mail/adapters/resendDriver.ts:24-36` calls `fetch`), and one verification function does not justify an SDK. If an SDK is adopted later, it stays inside `mail/adapters/`.
- **Evidence**: https://resend.com/docs/webhooks/verify-webhooks-requests (Svix headers); https://docs.svix.com/receiving/verifying-payloads/how-manual (signed content, `whsec_` secret, `v1,` entries, constant-time compare, tolerance); https://resend.com/docs/webhooks/retries-and-replays (schedule, manual replay).
- **Open risk**: Resend does not state a tolerance window or explicitly recommend `svix-id` for dedupe. Both are standard Svix behaviour and the double key covers a dashboard replay that mints a new `svix-id`. If the endpoint is down for longer than Resend's ~12 h retry span, events are lost at the provider. The alert on webhook-verification failures and the runbook's manual-replay step cover this (contracts/events.md).

### A4. Domains API, separate receiving and sending status

- **Decision**: The Resend `EmailDomainProvisioner` creates the domain in `RESEND_CHANNEL_REGION` with open and click tracking disabled, sending enabled, and receiving enabled only for the advanced direct-receiving option. Status mapping: `verified` → `verified`; `pending | not_started | temporary_failure` → `pending`; `failed` → `failed`; `partially_verified | partially_failed` → per capability from the record statuses. DNS records map to `{ purpose: dkim | spf | return_path | receiving_mx | dmarc, type, name, value, priority?, status }`. Resend does not return a DMARC record, so the adapter adds a recommended `_dmarc` TXT (`p=none`) and checks it with a DNS TXT lookup. DMARC status is advisory and never gates sending readiness.
- **Rationale**: Resend tracks `capabilities.{sending, receiving}` separately, which matches the spec's separate sending and receiving readiness. Its SPF/return-path records live on a `send.` subdomain, so the customer's root SPF is untouched, which keeps the spec's promise that the records are additive.
- **Domain uniqueness**: A domain can be active on only one Resend account at a time. A provider "already registered" error and a database unique-constraint conflict both map to the same `domain_claimed_elsewhere` refusal, which never names the other workspace (AS1.4).
- **Alternatives considered**: (a) Ask customers to point MX at the provider for every mailbox. Rejected: this is the spec's advanced option, never the default. (b) A single Radioso-owned sending domain with the customer's address only in `Reply-To`. Rejected: the spec requires sending as `support@customer.com`, and DMARC alignment needs the customer's DKIM.
- **Evidence**: https://resend.com/docs/api-reference/domains/create-domain (records, regions `us-east-1|eu-west-1|sa-east-1|ap-northeast-1`); https://resend.com/docs/dashboard/domains/manage-domains (`capabilities`, status enum); https://resend.com/docs/knowledge-base/domain-already-registered.
- **Open risk**: The exact JSON field names for `capabilities` and per-record status on create and get are pinned by adapter contract tests against recorded fixtures from the spike. The tracking CNAME is not shown because tracking is disabled.

### A5. Idempotency-key window

- **Decision**: Key the `Idempotency-Key` on the outbox action's stable idempotency key (`email:send:msg:<messageId>` or `email:send:held:<heldReplyId>`, at most 256 characters; research B6). Every retry and reconciliation re-POST sends a byte-identical body, so the outbound subject, text, HTML and headers are frozen into the send intent's `request_snapshot` on first attempt. Inside 23 h of the first attempt (a 1 h margin under Resend's 24 h window), re-POSTing with the same key is safe: Resend returns the original `id` if the first call was accepted, and sends once if it was not. After that, an unknown outcome becomes `uncertain` and is never re-sent without an audited operator decision (FR-036).
- **Rationale**: Without a key that is stable across retries, a crash between the provider's accept and our record step sends the customer two emails (AS3.2). Freezing the request makes a replay byte-identical, which is what the provider's replay semantics require.
- **Alternatives considered**: (a) A fresh key per attempt. Rejected: duplicates. (b) Treat any unknown outcome as `failed` and let an operator resend. Rejected: it turns a transient timeout into operator work, while a re-POST inside the window is provably safe.
- **Evidence**: https://resend.com/docs/dashboard/emails/idempotency-keys (24 h TTL, max 256 characters; replay with the same body returns the original id; different body gives `409 invalid_idempotent_request`; concurrent requests give `409 concurrent_idempotent_requests`; malformed key gives `400`). The existing driver already forwards the header (`backend/src/modules/mail/adapters/resendDriver.ts:21-23`).
- **Open risk**: `409 concurrent_idempotent_requests` is classified as retryable with an unknown outcome. `409 invalid_idempotent_request` means our snapshot changed and is a defect: the intent becomes `failed` with error code `idempotency_body_mismatch` and raises an alert.

### A6. Bounce and delivery events

- **Decision**: Subscribe to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`. Correlate by `data.email_id` = `email_send_intents.provider_message_id`. Transitions: `delivered` → `delivered`; `bounced | suppressed` → `bounced` with the sanitized `bounce.type/subType` code; `failed` → `failed`; `complained` records `complained_at` and an audit event with no state change; `delivery_delayed` only feeds a metric. Inbound DSNs (A12) are the second bounce source (FR-036). Transitions are monotonic and terminal states never regress, because events can arrive out of order.
- **Rationale**: FR-036 requires bounces from provider events as well as from inbound DSNs. The provider's own email id is the only correlation key that survives Message-Id rewriting.
- **Alternatives considered**: Poll `GET /emails/{id}` for every send instead of consuming events. Rejected: rate cost and latency. Polling is kept only as reconciliation for intents no event has settled.
- **Evidence**: https://resend.com/docs/webhooks/event-types; https://resend.com/docs/webhooks/emails/bounced (`data.bounce.{type, subType, message}`).
- **Open risk**: `bounce.message` can contain recipient addresses. It is never stored verbatim: only the type, the subtype and a sanitized enhanced status code (`5.1.1` style, matched structurally) are kept (FR-045).

### A7. Message-Id preservation

- **Decision**: Generate `<{uuid}.{shortId}@{sending domain}>` and pass it as `headers["Message-ID"]` along with `In-Reply-To`, `References` and, for agent-authored mail only, `Auto-Submitted: auto-generated`. After the send is accepted, the handler calls `GET /emails/{id}` and records `message_id` as `delivered_rfc_message_id`. When it differs from the supplied id, both are written to `email_thread_messages` (`origin = radioso_generated` and `origin = provider_delivered`), so thread resolution matches whichever id the customer's client quotes. The plus-address token is the third fallback.
- **Rationale**: FR-035 requires recording the Message-Id as delivered and defining reconciliation if the provider rewrites it. Recording both ids makes threading robust either way, without a branch on provider behaviour.
- **Alternatives considered**: Rely on the plus token alone. Rejected: forwarders may rewrite or strip `To`, and the spec makes Message-Id threading primary.
- **Evidence**: https://resend.com/docs/dashboard/emails/custom-headers (custom `headers` object); https://resend.com/docs/dashboard/receiving/reply-to-emails (setting `In-Reply-To`/`References` for threading); https://resend.com/docs/api-reference/emails/retrieve-email (`message_id`, `last_event`).
- **Open risk**: UNVERIFIED that Resend honours a supplied `Message-ID` and passes `Auto-Submitted` through. The S0 spike sends to a test mailbox and inspects the raw message. If `Auto-Submitted` is stripped, the docs say so and loop safety rests on our own send and generation budgets, which do not depend on the remote side.

### A8. Inbound on a Radioso-operated relay domain

- **Decision**: Each deployment has one relay domain (`EMAIL_CHANNEL_INBOUND_DOMAIN`, for example `in.eu.radioso.ai` and `in.us.radioso.ai`), registered once with receiving enabled by an operations runbook, not per workspace. Its MX points at the provider, and the provider's catch-all delivers every local part, so a new mailbox never touches DNS. Radioso Cloud uses one Resend account (or team) per region, so a regional webhook only ever sees its own region's mail and the EU stack's mail content stays in EU. If an account is shared, events for domains or outbound ids a stack does not own are recorded `ignored`. Self-hosters set their own domain and account, or use the `local` driver.
- **Rationale**: A relay domain owned by Radioso is what makes receiving need no customer DNS (US1). One domain per region keeps provider setup out of the per-workspace path.
- **Alternatives considered**: A per-workspace receiving subdomain. Rejected: it is per-workspace DNS work and was the topology the spec replaced on 2026-10-03.
- **Evidence**: https://resend.com/docs/dashboard/receiving/introduction; regions per A4.
- **Open risk**: UNVERIFIED which Resend regions support Receiving. If inbound is US-only, the EU stack's inbound content transits a US provider region. That data-residency question is flagged for the operator decision log before EU rollout (plan, Rollout).

### A9. Plus-address forwarding in Google Workspace and Microsoft 365

- **Decision**: Message-Id threading is primary and the plus token is the fallback. The plus token appears in `Reply-To` only after the mailbox's setup check has proven that plus-addressed mail reaches the relay (plan, Accepted deviations, item 1). The docs and the settings card state three facts: (1) Exchange Online blocks external automatic forwarding by default through the outbound anti-spam policy, so an admin must allow it, otherwise the forward fails with NDR 5.7.520; (2) Gmail and Workspace user-level forwarding requires confirming the destination with a code or link Google mails to that address, so the relay must receive and surface that email; (3) Exchange Online plus addressing is on by default and can be disabled by the admin.
- **Forwarding confirmation**: Google's confirmation mail arrives at the relay address directly (A2) and is recorded as an event on the mailbox. The setup panel lists the mailbox's first events with a sanitized raw view (D10), so the operator can read the code or click the link themselves. Radioso never follows links in inbound mail.
- **Rationale**: A forwarding rule the customer controls is invisible to Radioso, so the plan proves each hop with the setup check rather than assuming tenant defaults.
- **Alternatives considered**: Always put the plus token in `Reply-To`, as FR-033 literally says. Rejected for unverified mailboxes: a tenant with plus addressing disabled would bounce the customer's reply (plan, Accepted deviations, item 1).
- **Evidence**: https://learn.microsoft.com/en-us/exchange/recipients-in-exchange-online/plus-addressing-in-exchange-online; https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding; https://support.google.com/mail/answer/10957; https://techcommunity.microsoft.com/blog/exchange/all-you-need-to-know-about-automatic-email-forwarding-in-exchange-online/2074888 (envelope SRS rewrite, P2 headers preserved).
- **Open risk**: UNVERIFIED whether Google Workspace plus addressing is on by default with an admin toggle, and whether either platform keeps the original `Message-ID` on automatic forward. The S0 spike records both. If a forwarder rewrites `Message-ID`, threading falls back to the plus token, then to a new conversation, as the spec's edge cases allow.

### A10. Quoted-history and signature stripping

- **Decision**: Build a structural stripper in the email keystone (`emailChannel/content/quotedHistory.ts`) and take no library. It uses four signals: (1) HTML quote containers that mail clients emit as markup (`blockquote[type=cite]`, `.gmail_quote`, `#divRplyFwdMsg`, `#appendonsend`, `.moz-cite-prefix`, `.yahoo_quoted`); (2) the trailing `>`-prefixed block of a plain-text body (RFC 3676 §4.5), plus the single line directly before it when that line ends in `:`; (3) the RFC 3676 §4.3 signature separator `-- `; (4) a verbatim match of a message Radioso sent on this thread, cut from the line that begins it. The result is `confident` only when at least one signal matched and non-empty text remains. Otherwise the full text is kept (FR-013).
- **Rationale**: `email-reply-parser` and `planer` detect quotes with per-language regex word lists (`/On\s.+wrote:/`, `Le … a écrit`). That is English and European vocabulary encoding product behaviour, which CLAUDE.md forbids, and it silently fails for every language not on the list. Markup class names, quote prefixes and the sig-dash are format syntax, and the verbatim match needs no language at all.
- **Alternatives considered**: `email-reply-parser` 2.3.9 (MIT, about 10 locale lists); `planer` 1.2.0 (Talon port, last release 2023-12-18); unmaintained `talon` ports; LLM extraction (cost per message, nondeterministic, and it widens the prompt-injection surface before any operator sees the mail).
- **Evidence**: https://raw.githubusercontent.com/crisp-oss/email-reply-parser/master/lib/regex.ts; https://raw.githubusercontent.com/lever/planer/master/src/regexes.coffee; RFC 3676 https://www.rfc-editor.org/rfc/rfc3676.
- **Open risk**: Outlook plain-text replies carry no structural marker, so they keep their full text. That is the safe direction: the agent sees more, never less. The committed fixture corpus measures the strip rate per client.

### A11. MIME parsing, HTML-to-text, rendering sanitization

- **Decision**: Parse raw MIME with `postal-mime` (MIT-0, no dependencies) in a provider-neutral `mail/inboundMimeNormalizer.ts` that both the Resend and `local` receivers use. Convert HTML-only bodies with `html-to-text` 10.x (MIT) inside the keystone's customer-text step. Sanitize the operator raw view server-side with `sanitize-html` 2.x (MIT): scripts, event handlers, forms and remote resources are dropped, `src`/`href` are limited to `cid:` placeholders and `mailto:`, and `url()` in styles is removed. The frontend renders the result in a sandboxed `iframe srcdoc` with `sandbox=""`, so no script, form or top navigation can run. Plain text is the default view.
- **Rationale**: One parser, used at the adapter boundary, gives every provider the same normalized message, and server-side sanitization keeps a single trust boundary for untrusted HTML.
- **Alternatives considered**: `mailparser` 3.9 (MIT, stream API with more dependencies, heavier than needed for buffered messages); DOMPurify in the browser (moves the trust boundary to the client and adds a second sanitizer).
- **Evidence**: https://github.com/postalsys/postal-mime/releases; https://github.com/html-to-text/node-html-to-text; https://registry.npmjs.org/sanitize-html. None of these packages are in `backend/package.json` today.
- **Open risk**: Charset and encoded-word edge cases are covered by the fixture corpus (quickstart). Adding three dependencies goes through the standard dependency review.

### A12. RFC 3834 and related header handling

- **Decision**: Classification is a pure function over typed headers, compared as protocol tokens (case-insensitive, parameters ignored), applied in this order:

| Signal | Rule | Classification |
|---|---|---|
| `From` equals a workspace mailbox address or any relay address | exact address compare | `self_sender` |
| `Content-Type: multipart/report; report-type=delivery-status` | parse the `message/delivery-status` and `text/rfc822-headers` / `message/rfc822` parts for the original `Message-ID` | `bounce` when that id is a Radioso outbound id for the mailbox, else `automated_sender` |
| `Auto-Submitted` present with a value other than `no` | RFC 3834 §5 | `automated_sender` |
| `Precedence` ∈ {`bulk`, `list`, `junk`} | RFC 2076 legacy tokens cited by RFC 3834 | `automated_sender` |
| `X-Auto-Response-Suppress` present | MS-OXCMAIL | `automated_sender` |
| `List-Id` present | RFC 2919 | `automated_sender` |
| provider spam verdict = `spam` | adapter-supplied enum; `unknown` counts as not spam | `spam` |
| none of the above | | `person` |

  Outbound agent-authored mail carries `Auto-Submitted: auto-generated` (RFC 3834 §5). Operator-authored mail carries none (FR-034). Authentication results are recorded and never change the classification (FR-015).
- **Rationale**: The precedence values are protocol tokens, not product vocabulary, so this is the structural parsing CLAUDE.md allows. Subjects and bodies are never inspected.
- **Alternatives considered**: Subject or body heuristics, such as matching the words "out of office". Rejected by the anti-goal and CLAUDE.md. An LLM classifier is rejected for cost, and because it would put untrusted content in front of a model before the gate that decides whether the model runs.
- **Evidence**: https://datatracker.ietf.org/doc/html/rfc3834; https://www.rfc-editor.org/info/rfc3464; https://datatracker.ietf.org/doc/html/rfc2076; https://www.rfc-editor.org/info/rfc2919; https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcmail/ced68690-498a-4567-9d14-5c01f974d8b1.
- **Open risk**: Responders that send no automation headers are bounded by the thread send budget (FR-022) and the mailbox generation budget (FR-023), which is exactly what SC-006 tests.

---

## Part B: Architecture decisions

Revised on 2026-10-03 after the principal-engineer review (`.context/email-channel-plan-review.md`). The finding each decision answers is cited as "review #n" (blocking) or "review NB-n" (non-blocking).

### B1. Where the held reply lives, and the transaction capabilities around it (review #3)

- **Decision**: `held_replies` is a channel-neutral table owned by `backend/src/modules/handoff/heldReplies/`, with its repository in `backend/src/db/repositories/heldReplyRepository.ts` beside `conversationOwnershipRepository.ts`. Email is the first producer. It supplies an opaque `policyRef`/`policyVersion`, an opaque `reviewRef` (idempotency) and a hold-reason code; the handoff module interprets none of them.
- **Rationale (dependency direction)**: FR-030 requires a takeover and a free-form operator reply to supersede a pending held reply. Both run inside `ConversationOwnershipService` (`conversationOwnershipService.ts:139-160` takeover, `:163-223` transfer, `:277-330` reply) under the conversation and ownership row locks (`:298-301`). If held replies lived in `emailChannel/`, handoff would have to import a channel module, or supersession would happen outside the lock. So email depends down on handoff's public held-reply ports, and handoff never imports email.
- **Transaction-bound capabilities**: the existing scopes cannot do this today. `CustomerReplyRoute` only exposes `enqueue(outbox, message)` (`customerReplyDelivery.ts:31-34`), and neither ownership unit of work exposes held replies (`conversationOwnershipService.ts:50-72`). The plan adds narrow capabilities to the scopes. Composition only binds repositories to the open transaction; every decision stays in its owning module.

| Capability (port) | Owner (decides) | Added to scope | Bound by composition to |
|---|---|---|---|
| `HeldReplySupersedeScope.supersedePendingForConversation(conversationId, reason: "newer_inbound" \| "takeover" \| "operator_reply")` | handoff | `OwnershipChangeUnitOfWork` (takeover, transfer), `OwnershipReplyUnitOfWork` (reply), `ConversationIngestUnitOfWork` (newer inbound) | `HeldReplyRepository(trx)` |
| `HeldReplySupersedeScope.supersedePendingForPolicy(policyRef, "policy_changed")` | handoff | `MailboxPolicyChangeUnitOfWork` | `HeldReplyRepository(trx)` |
| `HeldReplyChannelScope.lockPolicy(policyRef): { version } \| null` | email keystone (reads and locks its mailbox row `FOR SHARE`) | `HeldReplyUnitOfWork` (release, discard, queue-auto, materialize) | `EmailMailboxRepository(trx)` via `emailChannel/heldReplyChannelScope.ts` |
| `HeldReplyChannelScope.reserveAutoSend(conversationId): boolean` | email keystone (send budget) | `HeldReplyUnitOfWork` (queue-auto only) | `EmailThreadRepository(trx)` |
| `HeldReplyChannelScope.enqueueAutoSend(heldReply, outbox)` | email keystone (outbox key and payload) | `HeldReplyUnitOfWork` (queue-auto only) | the transaction's `ActionRequestRepository` |
| `HeldReplyChannelScope.authorizeAutoDispatch(heldReply): AuthorityVerdict` and `recordMaterialized(heldReply, messageId)` | email keystone (FR-032 checks, send-intent row) | `HeldReplyUnitOfWork` (materialize-auto only) | `EmailMailboxRepository(trx)`, `EmailSendIntentRepository(trx)` |

  Handoff compares the bound policy version with the locked current version. Email decides what its policy and budgets permit. The scopes are keyed by `policyRef` prefix through a composition-built registry (`email_mailbox:` → email scope), so handoff never names email.
- **Release unit of work** (`backend/src/app/composition/heldReplyUnitOfWork.ts`), in one transaction:
  1. Lock the conversation row, then the ownership row (the same order as `reply`).
  2. `lockPolicy(policyRef)` and compare it with the bound `policy_version`.
  3. Conditional `UPDATE held_replies … WHERE id=$1 AND state='pending' AND ownership_version=$current RETURNING *`.
  4. Write the agent message (unchanged release) or operator message (edited release).
  5. Enqueue the channel route on the transaction's outbox.

  After commit, push a drain. Concurrent releases serialize on the row and the loser gets `held_reply_not_pending` (AS4.8). Release never calls `takeOver` (FR-029).
- **Policy change**: `MailboxPolicyChangeUnitOfWork` locks the mailbox row `FOR UPDATE`, bumps `policy_version`, appends a policy history row (B16) and calls `supersedePendingForPolicy` in the same transaction. A release that locked the policy `FOR SHARE` first wins and sends. A release that comes later sees the new version and refuses with `policy_changed`. There is no window.
- **Budget renewal (FR-022)**: the thread send budget is renewed when an operator-authorized send (operator reply, unchanged release or edited release) is materialized by the `email.send` handler, in the handler's own transaction. `OperatorReplyService` stays untouched, which the "registration only" rule requires. Between commit and dispatch, a review that sees the old budget can only hold, so the delay errs toward safety.
- **Alternatives considered**: (a) `approvals` / `pending_decisions` (`104_pending_decisions.sql`). Rejected: it is a routine-step gate with `routine_id`/`step_id NOT NULL`. (b) `emailChannel/`. Rejected on dependency direction. (c) Widen `CustomerReplyRoute`. Rejected: it changes `OperatorReplyService`.

### B2. The `review` execution mode and a discriminated completion result (review #2, NB-7)

- **Decision**: `TurnExecutionMode` becomes `"live" | "safe_test" | "review"` (`turnExecutionMode.ts:2`). A pure `turnExecutionCapabilities(mode)` returns:

| Capability | `live` (unchanged) | `safe_test` (unchanged) | `review` |
|---|---|---|---|
| `skillEffects` | `allowed` | `requested ?? suppressed` | `suppressed` (ignores `requested`) |
| `routines` (activation and suspended-routine resume) | `activate` | `activate` | `skip` |
| `completion` | `persist_reply` | `persist_reply` | `return_draft` |
| `ownershipHandoff` | `apply` | `skip` | `report` |
| `turnActions` | `enqueue` | `drop` | `drop` |
| `humanOwnedWaitingMessage` | `generate` | `generate` | `skip` |

- **Completion result**: `ChatResponse.assistantMessageId` is mandatory (`chatResponses.ts:51`), and completion dereferences the persisted message (`chatTurnLifecycle.ts:855-859`). So the internal `CompletedAssistantTurn` (`chatTurnLifecycle.ts:152-156`) becomes a discriminated union:
  - `{ kind: "persisted"; response: ChatResponse; assistantMessageId; postCommitReceipt }`, which is today's shape and stays the only shape `live` and `safe_test` ever see;
  - `{ kind: "draft"; draft: ReviewedTurnDraft; facts: ReviewTurnFactsSource; correlation: { requestMessageId; turnId }; postCommitReceipt }`.

  No assistant-message id is ever fabricated. Audit and coverage correlate on the customer message id and the turn id. Coverage is already keyed on `answerCoverageRequestMessageId: session.userMessage.id` (`chatTurnLifecycle.ts:734`). The audit event carries `metadata.requestMessageId` and `metadata.executionMode = "review"`.
- **Entry point**: review never goes through `ChatService.answer`. A new internal `ChatService.review(input: ChatReviewInput): Promise<ChatReviewResult>` returns `draft`, `no_draft` or `human_owned`. The public `answer`/`answerWithReceipt` signatures, the live HTTP response and `ChatResponse` are unchanged: the plan no longer adds fields to `ChatResponse`. `review` loads an existing customer message (`existingUserMessageId`) instead of creating one, and bounds history with `historyWindow`.
- **Where capabilities are read**:
  - `chatSessionPreparer.ts:605`: skill effects.
  - `chatService.ts:913-942`: both the suspended-routine short-circuit (`describeSuspendedRoutineTurn`, `:933`) and `attemptRoutineTurn` are skipped when `routines === "skip"`.
  - `chatService.ts:896-911`: the waiting message is skipped.
  - `chatTurnLifecycle.ts:669-787`: completion switches on `completion`.
- **Suppressed-effect evidence**: today suppression yields only a settled failure and a counter. R2 adds a per-turn collector that records **both** suppression sites, direct turn-skill dispatch (`agentSkillTurnSkillProvider.ts:309-311`) and staged-tool invoke (`:386-392`), and surfaces it on `ChatReviewResult.suppressedEffects`. The persisted reason string stays `suppressed_for_safe_test` for `safe_test`, because traces and the UI read it (`skillDispatcher.ts:37,174`, `frontend/components/dashboard/spine-stage-detail.tsx:1092`). `review` uses `suppressed_for_review`. Renaming the metric is not part of R2.
- **Alternatives considered**: (a) Reuse `safe_test`. Rejected: it persists the reply and can opt into effects. (b) Add optional fields to `ChatResponse` and a fake id. Rejected per review #2. (c) An engine-package mode. Rejected: `packages/conversation-engine` has no mode awareness.

### B3. Turn facts mapping (review #1)

`ChatReviewResult` carries the same sources the live turn produces: `answerOutcome` (`AssistantTurnOutcome`, `assistantTurnOutcomeTypes.ts:1-11`), the coverage record (`ChatAnswerCoverageAssessment`, `answerCoverage.ts:30-40`, whose `availability` is `AnswerCoverageAvailability = "assessed" | "not_recorded" | "failed" | "invalid"`, `packages/conversation-contract/index.d.ts:17`), the ownership hand-off signal, suppressed effects and citations. The pure mapper `backend/src/modules/connectors/services/connectorTurnFacts.ts` maps every value:

| `answerOutcome` | `grounding` |
|---|---|
| `grounded_success` | `grounded` |
| `coverage_partial` | `grounded` (coverage fact carries `partial`) |
| `no_context_refusal`, `coverage_unanswered` | `ungrounded` |
| `non_retrieval_response` | `not_applicable` |
| `coverage_unclear`, `coverage_unavailable`, absent, unrecognized | `unknown` |

| Coverage record | `coverage` |
|---|---|
| `availability: "assessed"` | narrow first, then `coverage` ∈ `answered`, `partial`, `unanswered`, `unclear` |
| `availability: "not_recorded"` or no record | `not_assessed` |
| `availability: "failed"` or `"invalid"` | `unavailable` |

The hand-off signal maps to `handoff: { requested: true, reason }`. A `no_draft` result with no signal maps to reason `review_unavailable`. The mapper is tested with real `ChatResponse` and `ChatReviewResult` fixtures produced by the lifecycle under test, not only with stubbed `ConnectorTurnResult` values. Unknown or not-assessed facts always fail closed in publication.

### B4. `delivery_failed` and held replies in the attention model (review #4)

- **Decision**: add the channel-neutral table `conversation_delivery_failures`, owned by `backend/src/modules/customerReplyDelivery/`. Email raises and clears rows through its recorder port. One change per layer:
  - Backend reader, plus `GET /api/v1/delivery-failures` and `POST /api/v1/delivery-failures/{id}/acknowledge|resolve`.
  - Ray: `NEEDS_ATTENTION_KINDS` (`needsAttention.ts:36`), `needsAttentionSourceByKind` (`:42-46`), the enums (`:85-120`) and `readDeliveryFailureQueue`. A new triage source id `delivery_failures` goes into `CopilotTriageSourceId` (`triageDigest.ts:43`) with permission `workspace.conversation.takeover` in `copilotTriageSourcePermissions` (`escalationSources.ts:48-55`).
  - Frontend: `EscalationType` (`frontend/lib/needs-attention.ts:24-35`) and a fourth query source (`needs-attention-query-state.ts:200-213`).
  - Activity kinds: `delivery_failed`, `delivery_failure_cleared` (closing).
- **Held replies in `approval`**: held replies are a second `approval` source (`GET /api/v1/held-replies?attention=open`) under the existing `approvals` triage source, which already requires `workspace.conversation.takeover` (`escalationSources.ts:49`). `GET /api/v1/decisions` stays routine-only.
- **Create, clear, reopen**:

| Path | Created by | Cleared by | Reopened by |
|---|---|---|---|
| `approval` (held reply `pending`) | hold | release, edited release, takeover, operator reply; supersede by a newer inbound replaces it | next held reply |
| `approval` after discard | discard (`attention_cleared_at` stays null) | operator reply or takeover | n/a |
| human-owned (`operator_only_mailbox`, `generation_budget`, `review_unavailable`, engine reasons) | ingest with an ownership reason, or `requestHumanOwnership` | hand-back | next hand-off |
| `delivery_failed` | intent `bounced`, `failed`, `uncertain`, `halted` | acknowledge; a later delivered send on the conversation; an audited resolution | a new failure (one open row per message) |

### B5. Operator-only conversations are human-owned at creation

The host port gains `ingest`, implemented by `backend/src/modules/chat/services/conversationIngestService.ts` over the composed `ConversationIngestUnitOfWork` (`backend/src/app/composition/conversationIngest.ts`). In one transaction it:
1. inserts the conversation if absent (caller-allocated id, `source_channel = "email"`, `channel_context`, `agent_id`, null `visitor_id` and `verified_customer_id`);
2. inserts the customer message if absent (caller-allocated id);
3. supersedes a pending held reply (`newer_inbound`) through the scope from B1;
4. when an ownership reason is given, calls `ConversationOwnershipService.requestHumanOwnership(scope, …)`, which wraps `ConversationOwnershipRepository.requestHandoff` (`conversationOwnershipRepository.ts:187-232`) and records `handoff_requested` in the same transaction.

The new reasons join the open union (`ownershipState.ts:5-9`). The reason column has no CHECK, so no migration is needed. Caller ids come from the thread protocol (B15), which makes `ingest` idempotent across retries. Metering: `ingest` reserves nothing, exactly like a human-owned web turn (`chatService.ts:889`, released at `:903-906`). Review turns reserve `conversation_reply` with surface `email`.

### B6. The `email.send` outbox, triggers, and revalidation (review #10)

- **Decision**: `email.send` rides the action outbox: `routine_action_requests`, the `ActionHandlerRegistry` (`actionDispatcher.ts:68-91`, lease 300 s, 5 attempts, 60 s backoff, `:61-65`), the Cloud Tasks drain and the `action_dispatch_recovery` scheduler. `EmailSendActionHandler` is registered by email composition, as Slack registers `slack.post` (`backend/src/modules/slack/composition.ts:6,27`).
- **Triggers, and where the message row is written**:

| Trigger | Message row written | Outbox key | Send intent materialized |
|---|---|---|---|
| `operator_reply` | by `OperatorReplyService` in the reply transaction (unchanged) | `email:send:msg:<messageId>` | handler, first claim |
| `held_release` (unchanged or edited) | by the held-reply release transaction (B1) | `email:send:msg:<messageId>` | handler, first claim |
| `auto_reply` | **not at publish.** The draft stays in `held_replies` (`queued_auto`). The message is written at dispatch by the materialize transaction (B9). | `email:send:held:<heldReplyId>` | the same materialize transaction, with the message |
| audited resend | none (reuses the message) | `email:send:msg:<messageId>:resend:<n>` | handler, first claim |

- **Revalidation applies only before the first provider call** (FR-032):
  - Operator-authorized triggers check that the domain is verified and not removed and that the mailbox is not removed. On failure the intent becomes `halted` and opens `delivery_failed`. The message is an operator-authorized message that did not go out. It is resendable only through the audited `resolve` path, never by another release.
  - Auto checks run inside the materialize transaction (B9).
  - **After any attempt with an unknown outcome, authority changes never halt or re-queue.** The intent keeps its unresolved status. While authority still holds and the 23 h window is open, it re-POSTs with the same key and the same frozen request. If authority has been revoked since, it does not re-POST: with no provider id there is no lookup, so it becomes `uncertain` at once and opens `delivery_failed`. Any deliberate duplicate-risk resend goes only through the audited resolution.
- **Handler steps**, with no transaction held across the provider call:
  1. Materialize or load the intent by key; return if terminal.
  2. Revalidate (first attempt only).
  3. Freeze the request snapshot.
  4. Call `EmailDriver.send` with the key.
  5. Apply the outcome through the fenced transition (B18).
  6. Fetch the delivered Message-Id (A7).

  `recordFailureOutcome` applies `failed`, or `uncertain` if any attempt's outcome was unknown.
- **Why inbound does not ride the outbox**: review turns are long model calls, and the local `ActionDispatchWorker` drains sequentially (`actionDispatchWorker.ts:51,82-85`). Coalescing also needs per-thread due times. The facet-job precedent (own table plus drain route) is followed instead.

### B7. Inbound job, scheduled wakeups, coalescing (review #7)

- **Stage 1** (per provider event, `email_inbound_events`): fetch, normalize and classify, fan out one `email_inbound_deliveries` row per mailbox, then run the thread protocol (B15), disposition and `ingest` for each delivery.
- **Stage 2** (per conversation, `email_thread_links.review_*`): a `run_review_turn` disposition increments `review_revision` and sets `review_due_at = COALESCE(review_due_at, now() + EMAIL_CHANNEL_COALESCE_SECONDS)`. When due, the worker claims the link with a lease, reserves a generation (B8), runs `review` against the newest customer message with the bounded history window, decides publication, and holds or queues (B9). See B17 for the revision protocol.
- **Wakeups**: R3's shared Cloud Tasks dispatcher keeps the facet dispatcher's `scheduleAt` (`cloudTasksFacetExtractionDrainDispatcher.ts:37-45`). `EmailChannelDrainDispatcherPort.requestDrain({ maxJobs, stage, scheduleAt? })` is called:
  - after the webhook commit (`inbound`, now);
  - after scheduling a review (`review`, at `review_due_at`);
  - after each retryable failure (`inbound` or `review`, at `next_attempt_at`);
  - after an unknown send outcome (`reconcile`, at the next re-POST time).

  The five-minute sweep remains purely for recovery (lost tasks, expired leases), refresh and retention. Locally the interval loop polls due rows every few seconds.
- **Terminal failure**: after `EMAIL_CHANNEL_REVIEW_MAX_ATTEMPTS` (default 4; backoff 30 s, 2 min, 10 min) the conversation becomes human-owned with `review_unavailable`, and the failure shows on the delivery in the event log.

### B8. Budgets

- **Generation (FR-023)**: a fixed one-hour window on the mailbox row, reserved with a single conditional `UPDATE … RETURNING` at turn start and keyed by `(conversation_id, review_revision)` through `email_thread_links.generation_reserved_revision`. A retried turn for the same revision does not charge twice. A failed reservation applies the `generation_budget` hand-off.
- **Thread send (FR-022)**: `reserveAutoSend` increments `auto_sends_since_renewal` inside the queue-auto transaction, which serializes on the thread link row. If the reservation is refused, the reply is held with `send_budget`. Renewal happens at materialization of operator-authorized sends (B1). Customer input never renews it. If an auto send later returns to `pending` (B9), the reservation is not refunded, which errs toward holding.

### B9. Auto publish keeps held content out of message rows (review #12, #10)

- **Decision**: a `publish` decision never writes a message row. The review runner calls `HeldReplyProducerPort.queueAuto(...)`, which in one held-reply transaction:
  1. locks the conversation, ownership and policy (B1);
  2. checks that the bound ownership and policy versions are current;
  3. reserves the send budget;
  4. inserts the held reply in state **`queued_auto`**;
  5. enqueues `email.send` with key `email:send:held:<heldReplyId>`.

  The handler's first claim calls `HeldReplyDispatchPort.materializeAuto(heldReplyId)`, which in one transaction:
  1. locks the conversation and ownership;
  2. runs a conditional `WHERE state = 'queued_auto'`;
  3. calls `authorizeAutoDispatch` (FR-032: mailbox enabled, mode `auto` at the bound policy version, ownership `ai_owned` at the bound version, domain verified);
  4. if authorized, writes the agent message from the draft (`draft_presentation`), moves the held reply to `released` (`release_kind = auto`) and records the send intent (`recordMaterialized`);
  5. if not, moves the held reply to `pending` with hold reason `authority_changed` and opens `approval`, and creates no message and no intent.

  Only an authorized, materialized send has a customer-visible message. That message carries the send intent from the moment it exists, which matches AS6.1.
- **Supersede races are closed by the state check**: a takeover, operator reply, newer inbound or policy change supersedes a `queued_auto` row in its own transaction (B1). Materialization then matches nothing and does nothing.
- **Unknown outcomes**: once materialized, the message exists and its intent follows B6. It never returns to a held reply, so there is never a normally releasable replacement for a send that may have been accepted (review #10).
- **Surfaces that must never show held content** (tested in `held-reply-visibility.integration.test.ts`):
  - `MessageRepositoryPort.listByConversationId`, `listRecentByConversationId`, `countByConversationId`, `listWindowByConversationId`, `listSinceByConversationId` (`messageRepository.ts:62-72`);
  - history and detail in `chatHistoryService.ts` (`:1198`), and the history API with its SDK and MCP counterparts;
  - the public conversation event bus (`message.created`) and the dashboard invalidation stream;
  - the review turn's history window (model context) and conversation-summary generation;
  - Ray `conversation_transcript`.

  The test covers held content in `pending`, `queued_auto`, `discarded`, `superseded` and returned-to-`pending` states.
- **Spec note**: FR-031 says the outbox action is "written in the same transaction as the message it delivers". For `auto_reply` the outbox action commits with the `queued_auto` held reply, and the message commits later with its send intent. This is the only way to satisfy FR-027, SC-004 and AS6.4 together. It is listed in plan.md, Plan review response, item 12.

### B10. Raw content storage and access

This decision is unchanged. Raw MIME is stored as capped `bytea` on `email_inbound_deliveries` (default 2 MiB, `raw_truncated`), with one copy per delivery. Conversation-linked deliveries cascade with the conversation. Conversation-less deliveries are purged after `EMAIL_CHANNEL_EVENT_RETENTION_DAYS`. Opening the raw view requires `workspace.conversation.takeover` and emits an audit event.

### B11. The `email` channel context

```json
{ "provider": "email", "mailbox": { "id": "uuid", "address": "support@customer.com" }, "threadKey": "uuid", "participant": { "address": "person@example.org" } }
```

The context holds stable identity only. The thread token is never in it. It is added to `packages/conversation-contract/index.d.ts:95-105` and its Zod mirror (`assistantHistorySchemas.ts:319-340`). The dispatcher already routes by `channelContext.provider` (`customerReplyDelivery.ts:52-59`). `callerKindForSourceChannel("email")` is `human` (`conversationSource.ts:32,50-53`).

### B12. Workers in both runtimes

`EmailChannelWorker` is wired three ways:
- an interval loop in `startWorkerRuntime` (`startWorkerRuntime.ts:38` neighbourhood);
- drain and sweep routes in `backend/src/app/worker/emailChannelWorkerTaskRoutes.ts`, modelled on `actionDispatchWorkerTaskRoutes.ts`;
- the scheduled Cloud Tasks dispatcher (B7).

Terraform adds an `email_channel` queue and an `email_channel_sweep` scheduler job. A runtime-startup test asserts both runtimes wire the worker. Workers stay off unless `EMAIL_CHANNEL_WORKERS_ENABLED=true`.

### B13. Inbox header and per-message facts

`GET /api/v1/conversations/{conversationId}/email` serves the latest projection and per-message facts. It ships in **S1**, because operator-only conversations appear in the Inbox from S1 and FR-038 needs sender, subject and mailbox in the header. Delivery state fields are null until S2. The frontend fetches it only when `channelContext.provider === "email"`.

### B14. Placement, permissions, and governance registries (review #4)

- **Routes**:
  - Settings live under `/api/v1/workspaces/{workspaceId}/email-channel/…` with `workspace.settings.read` / `manage`. They are registered as permission tuples in `apiPrincipalRoutePolicy.ts`, like `email-connections` (`:343-349`).
  - Held-reply, delivery-failure and conversation-facts routes are `sessionOnly(…, "workspace.conversation.takeover")`, like takeover and reply (`apiPrincipalRoutePolicy.ts:304-314`).
- **Ray tools** (`email_channel_configuration`, `email_channel_events`, `email_conversation_facts`, `held_replies`) each get all of:
  - an `operationPermissionRequirements.ts` entry for every operation they mirror (one-to-one parity);
  - a `copilotCapabilityProvenance` entry (bijection asserted at `capabilityProvenance.ts:126-135`);
  - an `operatorMcpDispositions` entry (bijection asserted at `operatorMcpDisposition.ts:150-160`);
  - a coverage-map entry.
- **Output shapes**: tool outputs are object-rooted for MCP (`mcpToolSchema.ts:30-48`). `held_replies` returns `{ heldReply: … | null }` for the current reply, and the HTTP route returns the same wrapper.
- **Token-free Ray projection (NB-2)**: Ray reads a dedicated `EmailChannelCopilotView` that selects fields explicitly at runtime. It never includes `relayAddress`, setup-check `sendTo`, thread tokens, raw content or addresses beyond the mailbox's own address.

### B15. Durable thread resolution protocol (review #9)

There is one protocol. It spans retries and host ingest and depends neither on processing order nor on an advisory lock being taken in a particular sequence.

1. **Resolve and reserve** (keystone transaction, under `pg_advisory_xact_lock(hash(mailbox_id, participant_address))`, with no external calls). For delivery D, with Message-Id M and references R (`References` ∪ `In-Reply-To`):
   - **Forward**: find conversations for ids in R among `email_thread_messages` (committed index) **and** among in-flight deliveries of the same mailbox in state `resolved` or `ingested` (`rfc_message_id ∈ R`, using their `planned_conversation_id`).
   - **Reverse**: find in-flight or done deliveries of the same mailbox whose `reference_ids` contain M (GIN index). This covers a follow-up processed before its parent.
   - **Token**: if neither matched, match the plus token in the delivered-to set.
   - **Decide** existing, new, participant mismatch or conflict (pure `resolveThread`). For a new thread, allocate `planned_conversation_id`, `planned_thread_key` and `planned_thread_token`.
   - **Persist** the decision, the planned ids and `planned_message_id` on D, and set D to `resolved`.

   Both members of an out-of-order pair hold the same lock key, because continuation requires the same participant, and the second one always sees the first's committed reservation.
2. **Ingest** (host unit of work): `ingest` with the planned ids, idempotent on both. Two deliveries reserved to the same new conversation both call `ingest` with `kind: "new"` and the same id, and the second becomes a no-op insert.
3. **Index** (keystone transaction): upsert the thread link (`ON CONFLICT DO NOTHING`), and insert `email_thread_messages` rows for M (`inbound`) and for each id in R not yet known (`referenced`). Unique `(mailbox_id, rfc_message_id)` with `ON CONFLICT DO NOTHING`. D moves to `done`.

A crash after step 1 resumes at step 2 with the persisted planned ids. A crash after step 2 resumes at step 3, because `ingest` is idempotent.

Interleavings added to SC-002 and SC-007:
- (i) follow-up resolved while the parent is `resolved` but not ingested;
- (ii) follow-up fully processed before the parent is fetched (the reverse match);
- (iii) crash between resolve and ingest;
- (iv) crash between ingest and index;
- (v) two deliveries concurrently starting the same new thread;
- (vi) parent arriving after the follow-up is `done`;
- (vii) the same Message-Id delivered to two mailboxes (independent per mailbox).

### B16. Policy effective at acceptance (review #8)

- **Decision**: add an append-only `email_mailbox_policies` table (`mailbox_id`, `version`, `mode`, `enabled`, `agent_id`, `effective_at`). It is written in the same transaction as every policy change. A delivery's `accepted_policy_version` is the version effective at its event's `received_at`, the webhook acceptance time, resolved in stage 1. The webhook itself stays inline-free (FR-007).
- **Execution authority** is the lower-autonomy mode of the accepted policy and the current policy (`operator_only` < `draft` < `auto`), and it requires `enabled` now. The disposition receives this `effectiveMode`. When a review is scheduled, the link stores `review_policy_version`, the accepted version of the newest coalesced delivery.
- **Bound policy at hold and publish**: the runner binds `policy_version` to the current version it read. `hold` and `queueAuto` lock the policy (B1). A changed version gives `hold` → inserted `superseded` (`policy_changed`) and the review is rescheduled, or `queueAuto` → refused, then held. Materialization re-checks again (B9). So a review already running when the policy changes cannot publish under the new policy, and a draft it creates afterwards is superseded at birth.

### B17. Review revision and completion (plan question 2)

- `email_thread_links.review_revision` increments on every `run_review_turn` scheduling. The runner claims with a lease and reads revision R.
- Held replies carry `review_ref = "email:<conversationId>:<R>"`, unique per conversation. `hold` and `queueAuto` are idempotent on it.
- Before running the model, the runner checks for an existing held reply with `review_ref` R. If it exists, a previous worker crashed after publishing, so the runner only completes.
- **Completion** is `UPDATE email_thread_links SET review_due_at = NULL, review_lease_until = NULL, review_completed_revision = R WHERE conversation_id = $1 AND review_revision = R`. A stale worker whose revision was overtaken by a newer inbound never clears the newer due time. Its draft is held as `superseded` (`answers_message_id` is not the latest), and the newer revision runs.
- A crash between publish and completion re-claims after the lease, finds the `review_ref`, and completes without a second turn or send.

### B18. Send-intent concurrency fence and late provider evidence (review #11)

- `email_send_intents.version` is incremented by every transition. All writers (the handler, the provider-event processor, the reconciler, the operator resolution) apply `sendIntentTransitions` through one repository method, `transition(id, expectedVersion, event)`, which runs `UPDATE … WHERE id = $1 AND version = $2`. A lost race re-reads and re-applies, or drops the event if the state is now terminal.
- The reconciler claims due intents with `FOR UPDATE SKIP LOCKED` and `reconcile_lease_until`, so two sweeps never look up the same intent.
- Late provider evidence resolves `uncertain` without any resend:
  - a delivered event or a `lookup` `last_event = delivered` → `delivered` (`uncertain_resolution = provider_evidence`);
  - bounced or suppressed → `bounced`;
  - failed → `failed`.

  Each clears or retargets the open `delivery_failed` row. An audited `resend` creates a new intent under `…:resend:<n>` and is the only path to a second provider call.

### B19. Online migration strategy for shared tables (review #6, NB-5)

The migration runner executes each file in one transaction with `lock_timeout = 0` (`runMigrations.ts:100-104,212-218`).

- **Activity kinds** are widened once, for every kind this feature needs (`channel_exception`, `delivery_failed`, `delivery_failure_cleared`, `held_reply_released`, `held_reply_discarded`), in three committed migrations:
  1. `SET LOCAL lock_timeout = '3s'`, then `ADD CONSTRAINT conversation_activity_kind_v2_check CHECK (…) NOT VALID`. This is a brief exclusive lock.
  2. `VALIDATE CONSTRAINT conversation_activity_kind_v2_check`, under `SHARE UPDATE EXCLUSIVE`, so writes continue.
  3. `SET LOCAL lock_timeout = '3s'`, then `DROP CONSTRAINT conversation_activity_kind_check`. This is brief.

  A lock-timeout failure fails the deploy fast instead of queueing application traffic behind it, and a retry is safe. The new kinds are written only by code that ships after step 3.
- **Closing index**: a replacement partial index `conversation_activity_workspace_closed_v2_idx` includes the two new closing kinds. Its migration uses `CREATE INDEX IF NOT EXISTS` with `lock_timeout = '3s'`. The runbook pre-creates it `CONCURRENTLY` in production when `conversation_activity` exceeds 100k rows, which turns the migration into a no-op. The old index is dropped one slice later (S2), after no running version reads it. The recently-closed query and its OpenAPI enum (`assistantHistorySchemas.ts`, which reads `CLOSING_ACTIVITY_KINDS`) switch together with the new index.
- **New-table FKs** are added in the migration that creates the referenced table (data-model.md, Migrations), never forward.

### B20. Direct-receiving routing (FR-006a, plan question 1)

- **Mapping**: an address resolves a mailbox by one of two rules, and no other.
  - **Relay rule (default)**: the address is on `EMAIL_CHANNEL_INBOUND_DOMAIN`, and its local part is a current or in-grace relay token.
  - **Direct rule (advanced)**: the address's domain is an `email_domains` row with `receiving_status = 'verified'` and `removed_at IS NULL`, and the full address equals the `address` of an active mailbox on that domain (case-insensitive, with the `+tag` part removed before comparison).
- **Why the direct rule is safe**: the customer has pointed that domain's MX at the provider and confirmed by typing the domain (FR-006a). Every address on it is Radioso-delivered by construction, so matching the recipient is not "routing by the `To` header of forwarded mail". Forwarded mail to a customer domain that is *not* receiving-verified never matches.
- **Unknown local parts**: an address on a receiving-verified domain that matches no mailbox is recorded `no_mailbox` and attributed to the domain's workspace, so it shows in that workspace's event log.
- **Plus tags**: on a direct domain, the `+tag` part is the thread token (the same as the relay path), so `Reply-To` works without forwarding.
- **Webhook attribution**: Resend's catch-all delivers the direct domain to the same webhook. Stage 1 checks the relay rule first, then the direct rule.
