# Feature Specification: Email Channel (customer-owned domain, operator-gated agent)

**Feature Branch**: `1403-email-channel`

**Created**: 2026-10-03

**Status**: Draft (revised 2026-10-03 after the challenge and CEO reviews in `reviews/`)

**Issue**: #1403

**Input**: User description: "I need email as a channel. Use an email provider abstraction with Resend as the specific implementation. Customer-owned domains. Auto-reply loop protection. No auto-close: what matters is whether the conversation needs operator attention, which follows the same rule as chat. Do not let the AI go wild and be wholly responsible for the inbox; it needs rules for when to engage and when to leave it for an operator."

## Framing

Email is the first Radioso channel where the operator, not the agent, is the default author. A person who emails `support@customer.com` expects a competent reply from the company; they do not care whether a person or an agent wrote it, as long as it is right and nothing was promised that the company did not mean. That changes the engagement contract:

1. **The mailbox belongs to the operator.** Every email the system accepts is visible to operators somewhere: as a conversation in the inbox, or as an event in the mailbox's event log when it never becomes a conversation. "The agent must not act" never means "the operator must not see."
2. **Three decisions, not one.** For every accepted inbound message the system decides, in order, *whether the agent runs* (structural, before any model call), *what it may do while running* (no externally visible skill effects on email this release), and *whether its output may be published* (fail-closed: only an explicitly grounded, complete, non-hand-off outcome on an `auto` mailbox is sent; everything else is held for a person). None of these decisions encode product vocabulary in code.
3. **Held replies are the default.** In `draft` mode the agent writes a reply that an operator sends, edits, or discards. `auto` is a per-mailbox opt-in with a hard send budget and still falls back to a held reply whenever the publication decision says so.
4. **No auto-close.** An email conversation stays open like a chat conversation. Operator attention reuses the inbox's existing kinds: a held reply is a pending decision, an operator-only conversation is human-owned from creation, and a delivery failure is a new kind added once for every channel.
5. **Relay in, customer identity out.** Email routes by domain, never by mailbox, so Radioso does not take over the customer's domain. Each connected mailbox gets a Radioso-provided inbound relay address on an inbound domain Radioso operates (configured per deployment; self-hosters supply their own). The customer forwards their existing address, say `support@customer.com`, to that relay address from their current mail service and keeps their mailbox where it is. Replies are sent as `support@customer.com` once the customer has added the provider's DKIM and SPF records to `customer.com`; those records are additive and break nothing. Pointing a customer-owned domain or subdomain's MX at the provider is an advanced receiving option, never the default.
6. **Durable ingress.** Mail the system has acknowledged to the provider cannot be lost. Acceptance persists a verified event before the webhook returns; everything after that is a retryable worker job with a visible terminal failure.

This is net-new code that mirrors two existing precedents for *module boundaries*: the Slack and WhatsApp `ConnectorPlugin` channels (`backend/src/modules/connectors/plugins/`) for inbound ingress and outbox delivery, and the Slack reply deliverer registered in `CustomerReplyDeliveryDispatcher` for operator replies. It does not inherit their durability model: the Slack handler schedules processing in-process after acknowledging, which is not acceptable for mail. The outbound mail port already exists (`backend/src/modules/mail/emailService.ts`, `EmailDriver`, Resend adapter). Inbound receipt and domain provisioning are new ports with Resend as the first adapter.

## User Scenarios & Testing *(mandatory)*

Stories are sliced so each is independently shippable and each is the rollout gate for the next. Priority order: make mail land reliably in the inbox with the agent silent; let the operator reply; let the agent draft; bound every automatic behavior; only then let the agent send.

### User Story 1 - Connect a mailbox by forwarding and verify sending (Priority: P1)

An operator adds `support@customer.com` as a mailbox in workspace settings and binds it to an agent in `operator_only` mode. Radioso shows them a relay address to forward to. They add a forwarding rule in their existing mail service, run the setup check, and see mail landing in the inbox as human-owned conversations. Separately they add the DKIM and SPF records Radioso shows for `customer.com` so replies can go out as `support@customer.com`.

**Why this priority**: Nothing works without a connected mailbox, and `operator_only` makes the channel useful on day one with zero agent risk. Receiving needs no DNS at all, so a team can be live in minutes and verify sending when they are ready to reply.

**Independent Test**: Create a mailbox through the settings API, read its relay address, deliver a provider webhook addressed to that relay address carrying a forwarded first-contact email. A human-owned conversation exists in the inbox with the customer message and no agent message. A webhook addressed to an unknown relay token produces an event visible in the workspace event log and no conversation. Register the sending domain through the provisioner port, mark it verified through the adapter, and confirm the mailbox reports sending ready.

**Acceptance Scenarios**:

1. **Given** a workspace with no mailboxes, **When** the operator adds `support@customer.com`, **Then** a mailbox exists with an opaque relay address on the deployment's inbound domain, the settings card shows that address with a copy control and forwarding instructions for common mail services, and the mailbox shows `receiving: waiting for first message`, `sending: not verified`.
2. **Given** a mailbox whose relay address has never received mail, **When** the operator runs the setup check, **Then** the system tells them to send any message to `support@customer.com`, and when it arrives through the relay the mailbox shows `receiving: ok` with the time of the last message received.
3. **Given** `customer.com` is not yet a sending domain for the workspace, **When** the operator adds the mailbox, **Then** the sending domain is registered with the provider and the card shows the DKIM, SPF, and DMARC records with per-record copy and per-record status, with sending `pending`.
4. **Given** the operator adds a sending domain already claimed by another workspace, **When** they submit it, **Then** the request is refused and the UI says the domain is claimed elsewhere, without naming the other workspace.
5. **Given** a sending domain whose records resolve, **When** verification runs, **Then** every mailbox on that domain shows `sending: ok`, and replies on their conversations become sendable.
6. **Given** a mailbox receiving mail but whose sending domain is not verified, **When** the agent produces a reply, **Then** it is held with reason `sending_not_verified`; **and when** an operator submits a reply, **Then** it is refused before anything is written, the composer says what is missing, and retrying after verification is safe.
7. **Given** a mailbox bound to an agent in `operator_only` mode, **When** forwarded mail arrives at its relay address, **Then** a conversation opens with `sourceChannel: "email"`, an `email` channel context naming the mailbox, human ownership with reason `operator_only_mailbox`, and no agent turn runs.
8. **Given** mail arrives at the inbound domain for a relay token that matches no mailbox, **When** it is processed, **Then** an event with disposition `no_mailbox` is recorded, visible in the workspace event log with sender and subject, and no conversation opens.
9. **Given** a mailbox, **When** the operator disables it, **Then** later mail to its relay address is recorded with disposition `mailbox_disabled` in the event log, and any unsent automatic reply on its conversations is halted.
10. **Given** a mailbox that has received mail before, **When** nothing has arrived for longer than the mailbox's silence threshold, **Then** the card shows the last received time and a notice that forwarding may have stopped, because a removed forwarding rule is invisible to Radioso.
11. **Given** an operator who wants direct receiving, **When** they choose the advanced option and add a customer-owned domain or subdomain for receiving, **Then** the card shows the MX record, names that all mail for that domain will route to Radioso, requires a typed confirmation, and tracks receiving readiness for it separately.

---

### User Story 2 - Inbound mail threads into conversations, durably (Priority: P1)

A customer emails `support@customer.com`. The customer's mail service forwards it to the mailbox's relay address. A conversation opens. Every later message in the same thread, including a follow-up sent before anyone replied, continues that conversation. A fresh email with no thread reference opens a new conversation. Nothing the provider has been told was accepted is ever lost.

**Why this priority**: Threading is the identity model of the channel and durability is the floor under it.

**Independent Test**: Deliver provider webhook payloads for: a first-contact email; a customer follow-up whose `In-Reply-To` names the customer's own first message; a reply naming a Radioso-generated Message-Id; a reply carrying only the plus-address token; the same provider event twice; one message addressed to two bound mailboxes. Resolution matches the expected conversations, the duplicate is ignored, and the two-mailbox message produces two conversations. Kill the worker between acknowledgment and content fetch; on restart the message is processed exactly once.

**Acceptance Scenarios**:

1. **Given** a verified webhook, **When** the provider delivers an event, **Then** the event and a processing obligation are persisted atomically before the webhook returns success; nothing else runs inline.
2. **Given** a persisted event, **When** the worker processes it, **Then** it fetches the message content from the provider with retry, normalizes it, records the inbound Message-Id, and runs the engagement disposition; a terminal fetch failure marks the event `failed` and makes it visible in the event log with a retry action.
3. **Given** no conversation for the thread, **When** a first-contact email arrives at a mailbox's relay address, **Then** the mailbox is resolved from the relay token on the delivered-to address, never from the `To` header, and a conversation opens with the original sender as the channel participant, the mailbox and thread key on the channel context, and the email body as the first customer message.
3a. **Given** a forwarded message, **When** it is normalized, **Then** the original sender, original recipient, and the provider's authentication results are recorded on the event; authentication failures caused by forwarding are informational and never a reason to drop.
4. **Given** a conversation with only inbound messages so far, **When** a follow-up arrives whose `In-Reply-To` or `References` names an inbound Message-Id recorded for that mailbox, **Then** it continues that conversation.
5. **Given** a conversation with an outbound message, **When** a reply names a Radioso-generated Message-Id or the plus-address token for that mailbox, **Then** it continues that conversation.
6. **Given** a reply whose references match a conversation but whose sender is not the conversation's participant, **When** it is processed, **Then** it is recorded as an event with disposition `participant_mismatch`, attached to the conversation as an operator-visible exception, and no turn runs.
7. **Given** an event already processed, **When** the provider delivers it again, **Then** it is acknowledged and ignored; **and given** one customer message forwarded by two connected mailboxes, **Then** each relay delivery is its own event and each mailbox gets its own conversation.
8. **Given** an HTML-only body, **When** it is normalized, **Then** the customer message is text with quoted history and signature stripped when the parser is confident, the full text when it is not, and the raw body is stored with the event.
9. **Given** attachments, **When** the message is normalized, **Then** names, types, and sizes are recorded on the message, content is neither ingested nor passed to the agent, and operators can open the stored raw message.

---

### User Story 3 - Operator replies from the inbox by email (Priority: P2)

An operator opens an email conversation, types a reply, and the customer receives it in the same thread from `support@customer.com`. The customer's own reply goes to `support@customer.com`, is forwarded by their mail service, and continues the conversation.

**Why this priority**: With stories 1 and 2 the inbox is a mirror. Replying makes it a working support channel before the agent writes a word.

**Independent Test**: Post an operator reply through the existing reply service on an email conversation. A send intent with a stable idempotency key and an `email.send` outbox action are written in the same transaction; the worker sends through the driver with the threading headers set; the provider's message id and the delivered Message-Id are recorded; a later provider bounce event marks the message bounced and flags the conversation.

**Acceptance Scenarios**:

1. **Given** an email conversation, **When** an operator replies from the inbox, **Then** the reply is saved as an operator message and delivered as an email whose `In-Reply-To` and `References` name the latest inbound message and whose `Reply-To` carries the thread token.
2. **Given** a send intent, **When** the worker crashes after the provider accepted it, **Then** the retry reuses the same idempotency key and the customer receives one email.
3. **Given** a send the provider accepted, **When** the provider later reports a bounce, **Then** the outbound record becomes `bounced`, the conversation is flagged with attention kind `delivery_failed`, and the failure detail is visible on the message.
4. **Given** a send whose outcome is unknown past the provider's idempotency window, **When** reconciliation cannot settle it, **Then** it is marked `uncertain`, flagged for attention, and never resent without an audited operator decision.
5. **Given** an operator-authored email, **When** it is sent, **Then** it carries no `Auto-Submitted` header.
6. **Given** an operator has replied, **When** the customer replies again, **Then** the conversation is human-owned and the agent does not run, exactly as after a chat takeover.
7. **Given** a domain whose sending authority was revoked after the reply was queued, **When** the worker picks it up, **Then** it revalidates authority, does not send, and flags the message.

---

### User Story 4 - Agent drafts, operator sends (Priority: P2)

A mailbox is set to `draft`. When a customer emails, the agent runs a review turn and produces a held reply. The operator sees the draft with the turn's outcome and reasoning, and sends it, edits then sends, or discards it.

**Why this priority**: This is the engagement mode that answers the brief. The agent does the work, a person stays accountable, and the team sees the agent's judgment before trusting it with `auto`.

**Independent Test**: Ingest an email on a `draft` mailbox. A held reply exists, visible to operators only, not in customer-visible history, with no outbox row. Sending delivers an agent-attributed email. Editing then sending delivers the edited text attributed to the operator with the original retained. Discarding leaves the conversation flagged. A second inbound before review supersedes the first draft. Two concurrent release attempts produce one send.

**Acceptance Scenarios**:

1. **Given** a `draft` mailbox, **When** an inbound email is accepted, **Then** the turn runs in `review` execution mode: durable conversation, externally visible skill effects suppressed, routines not activated, hand-off and coverage signals recorded; its output is persisted as a held reply bound to that inbound revision, and the conversation is flagged with attention kind `approval`.
2. **Given** a held reply, **When** the operator sends it unchanged, **Then** it becomes a customer-visible agent message, is delivered with `Auto-Submitted: auto-generated`, ownership is unchanged, and an audit event names the releasing operator.
3. **Given** a held reply, **When** the operator edits and sends it, **Then** the delivered message is attributed to the operator, the original draft is retained on the held reply, ownership is unchanged, and the email carries no `Auto-Submitted` header.
4. **Given** a held reply, **When** the operator discards it, **Then** it is marked `discarded`, the conversation stays flagged until an operator replies or takes it over, and the next inbound produces a fresh draft.
5. **Given** a turn whose outcome is a hand-off, out-of-scope, no-context, or unavailable, **When** it ends with usable text, **Then** the text is held with the outcome labelled; **and when** it ends with no text, **Then** no held reply is created and the conversation is flagged with the engine's hand-off reason.
6. **Given** a turn that needed a suppressed skill effect to answer, **When** it ends, **Then** the held reply is labelled as depending on an action that did not run, and the draft text does not claim the action happened.
7. **Given** a pending held reply, **When** a newer inbound arrives on the thread, **Then** the pending draft becomes `superseded`, a new review turn runs over the bounded thread context, and the operator sees one current draft.
8. **Given** a pending held reply, **When** two operators release it concurrently, **Then** exactly one send intent is created and the other request sees that it was already released.
9. **Given** a pending held reply, **When** an operator replies free-form or takes the conversation over, **Then** the draft becomes `superseded` and the conversation is human-owned.

---

### User Story 5 - Every automatic behavior is bounded (Priority: P1 for any mode that sends; ships with story 4)

Automated mail never gets an agent reply. Bounces are visible. A thread never receives more than a fixed number of automatic sends without an operator renewing the budget. A flood of new threads cannot run up model spend unboundedly.

**Why this priority**: One vacation responder, or one spammer, on an `auto` mailbox can generate hundreds of billable turns and emails in minutes.

**Independent Test**: Deliver inbound payloads with `Auto-Submitted: auto-replied`, `Precedence: bulk`, a `multipart/report` delivery status, and a `From` equal to the mailbox itself; none run a turn. Simulate a responder with no automation headers on an `auto` mailbox; sends stop at the thread budget with one attention flag. Deliver 200 unique first-contact messages in a minute on a `draft` mailbox; generation stops at the mailbox budget, the rest are ingested as operator-only conversations and flagged, and nothing is lost.

**Acceptance Scenarios**:

1. **Given** `Auto-Submitted` other than `no`, `Precedence: bulk|list|junk`, `X-Auto-Response-Suppress`, or `List-Id`, **When** the message is processed, **Then** it is recorded with disposition `automated_sender`, attached to its thread as an operator-visible note when the thread exists, and no turn runs.
2. **Given** a delivery status notification referencing a Radioso outbound Message-Id, **When** processed, **Then** the outbound record is marked `bounced` and the conversation is flagged `delivery_failed`.
3. **Given** a sender that is one of the workspace's own mailboxes, **When** processed, **Then** the message is dropped with disposition `self_sender`.
4. **Given** an `auto` mailbox thread, **When** the agent has made the thread's automatic send budget of sends since the last operator renewal, **Then** the next candidate reply is held with attention kind `approval` and reason `send_budget`, and customer input never resets the budget.
5. **Given** a mailbox, **When** review-turn generations in the current hour reach the mailbox generation budget, **Then** further accepted inbound on that mailbox is ingested as operator-only conversations with reason `generation_budget` until the window rolls.
6. **Given** several inbound messages on one thread inside the coalescing window, **When** the worker processes them, **Then** one review turn runs over all of them.
7. **Given** any agent-authored email, **When** it is sent, **Then** it carries `Auto-Submitted: auto-generated`.
8. **Given** an operator downgrades a mailbox from `auto` to `draft` or `operator_only`, **When** unsent automatic replies exist, **Then** they are halted and held; upgrades apply only to inbound accepted after the change.

---

### User Story 6 - Agent answers automatically when the publication decision allows (Priority: P4)

A mailbox is set to `auto`. When the review turn ends as a grounded, complete answer with no hand-off signal and the thread's send budget has room, the reply is sent without a person in the loop. Any other outcome is held exactly as in `draft`.

**Why this priority**: `auto` is the throughput mode and the one with real downside. It ships only after a workspace has run `draft` and the publication decision has a proven outcome table.

**Independent Test**: On an `auto` mailbox, a question covered by the knowledge base is answered by email with `Auto-Submitted: auto-generated`. A question outside coverage, a partial answer, a hand-off, and an unavailable turn each produce a held reply and an attention flag, not an email.

**Acceptance Scenarios**:

1. **Given** an `auto` mailbox, **When** the publication decision is `publish`, **Then** a send intent is created in the same transaction as the agent message and delivered through the outbox.
2. **Given** an `auto` mailbox, **When** the publication decision is anything else, **Then** the reply is held with the outcome labelled and the conversation is flagged `approval`.
3. **Given** an `auto` mailbox and a human-owned conversation, **When** a customer email arrives, **Then** the agent does not run.
4. **Given** an `auto` mailbox, **When** a send intent is dispatched, **Then** the worker revalidates mailbox mode, domain sending authority, ownership, and send budget before calling the provider, and holds instead of sending if any changed.

---

### Edge Cases

- One inbound email asks several unrelated questions. The review turn addresses the email as one unit; routines that ask one clarifying question at a time are not activated from email in this release.
- The customer CCs other people. The reply goes to the original sender only; CC addresses are recorded on the message and shown in the inbox.
- The customer writes to the plus-address token directly with a new subject. It continues the conversation the token names; the subject change is recorded on the message.
- A sending domain's DNS records are later removed. Provider verification lapses within the freshness window, sending readiness drops, queued sends hold, inbound is unaffected because it arrives through the relay, and the settings card flags the domain.
- The customer removes the forwarding rule. Radioso cannot see this; the mailbox's last-received time and silence notice are the only signal, and the setup check re-proves the path.
- A webhook arrives for a relay token of a removed mailbox or one inside its rotation grace period. Recorded `no_mailbox` in that workspace's event log, acknowledged, not retried. A token that was never issued names no workspace; it is counted in deployment metrics and swept by retention.
- Microsoft 365 blocks external auto-forwarding until an admin changes the outbound anti-spam policy, and Google asks the forwarding target to confirm a code. The setup panel surfaces the confirmation message that arrives at the relay address, and the docs state both.
- The provider reports spam. Recorded with disposition `drop`, reason `spam`, as a bounded event; no turn runs and no conversation opens; `unknown` verdicts are treated as not spam. Authentication results are recorded on every event and never drop a message on their own, because forwarding routinely breaks SPF.
- The customer's mail service rewrites the forwarded message (new Message-Id, subject prefix, wrapped body). Thread resolution falls back from headers to the plus-address token to a new conversation; the raw event keeps whatever arrived.
- A held reply exists and the operator takes over. The draft is superseded.
- The same person emails from two addresses. Two participants, two conversations.
- A long thread. The review turn reads a bounded window of the thread plus the current message; the bound is fixed at the thread's 10 newest messages.
- Model provider or mail provider outage. Review turns and sends retry within their jobs; after the retry budget the event or send intent is terminal-failed and visible; nothing acknowledged is dropped.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Backend runtime LLM prompt templates MUST live under `backend/prompts/`.
- Backend HTTP contract changes MUST update the code-first OpenAPI registry and regenerate checked-in artifacts.
- Public and cross-service contract changes MUST include a message-queue impact review.
- Contract and functionality changes MUST identify and update the affected documentation.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Mail ports (`backend/src/modules/mail/`)*: three provider-neutral ports, one file each, Resend adapters in `mail/adapters/`. `EmailDriver` (exists) gains typed threading headers, a per-send `from` on a verified domain, and returns the provider's message id and the Message-Id as delivered. `InboundEmailReceiver` (new) verifies a provider webhook into a verified event envelope and fetches message content for an event into a normalized `InboundEmailMessage`, which carries provider authentication results and an optional spam verdict. `EmailDomainProvisioner` (new) registers a sending domain, returns DNS records, and reports readiness; it also registers a receiving domain for the advanced direct-MX option and reports receiving readiness separately. The deployment's inbound relay domain is configuration (`.env` and `.env.example`), provisioned once per deployment, not per workspace. The ports know nothing about conversations, mailboxes, or agents.
  - *Transport/inbound (`connectors/plugins/email/`)*: the email `ConnectorPlugin` mounts the webhook under `/api/connectors/email/...`. Inline it verifies, persists the event with its processing obligation, and returns. A worker job owns the rest: content fetch, normalization, thread resolution, the engagement disposition (pure function, no I/O), and the call into the host port. It depends down on the mail ports and the channel keystone, never on Slack or WhatsApp code.
  - *Channel keystone (`backend/src/modules/emailChannel/`)*: owns sending domains, optional receiving domains, mailboxes with their relay tokens, engagement modes, budgets, thread links, inbound and outbound Message-Id records, send intents, the event log, and the quoted-history stripper. The plugin, the deliverer, the settings routes, and the Ray tools depend down on it.
  - *Host port*: `ConnectorChatPort` gains an ingest-only operation that records a customer message without running a turn, and its turn operation accepts a typed `TurnExecutionMode` and returns a typed result carrying the grounding, coverage, and hand-off facts the publication decision needs. The port returns facts; the email worker decides.
  - *Orchestration*: the conversation engine gains a `review` execution mode alongside `live` and `safe_test`: durable conversation, effects suppressed, routines not activated, hand-off signals recorded, output returned to the caller instead of persisted as an assistant message. No email branching inside the engine; the mode is channel-neutral.
  - *Held reply*: a channel-neutral review record owned by the conversations or handoff domain with a lifecycle (`pending`, `released`, `edited`, `discarded`, `superseded`), bound to the inbound revision, ownership version, and mailbox policy version it answered. Email is its first consumer. Provider send status stays in the email keystone.
  - *Outbound delivery (one mechanism, three triggers)*: a send intent row plus an `email.send` outbox action, handled by one worker job that revalidates authority and calls `EmailDriver`. Fed by the auto reply, the released held reply, and the operator reply through `EmailCustomerReplyDeliverer` registered in `CustomerReplyDeliveryDispatcher` under provider `email`. Triggers never call the driver directly.
  - *Attention*: operator-only conversations enter the inbox through human ownership; held replies enter through the existing `approval` kind; `delivery_failed` is a new kind added to the shared attention model, not an email-only queue.
  - *Persistence*: new tables for domains, mailboxes, inbound events, thread message ids, thread links, send intents, and held replies. Conversations reuse `source_channel` and `channel_context`; the `email` channel context holds only stable identity (mailbox, thread key, participant address). Subject, display name, CC list, and envelope facts live on messages and events with a "latest" projection for the inbox header.
- **Encapsulation Rule**:
  - `backend/src/modules/mail/` stays provider-and-transport only. Every driver, including `log` and `noop`, MUST redact subject, body, addresses, and headers for channel mail; the current `log` driver's full-message logging is not acceptable for this channel.
  - The engagement disposition is a pure function with typed inputs (mode, classification, ownership state, participant match, budgets) and a typed result (`ingest_only`, `run_review_turn`, `drop`), mirroring `slackChannelMessageDisposition.ts`.
  - The publication decision is a pure function of the typed turn result, mailbox mode, send budget, and ownership, returning `publish` or `hold` with a reason. It never reads prompts, completions, or free text.
  - `OperatorReplyService` and `CustomerReplyDeliveryDispatcher` are extended by registration only.
  - No database transaction or connection is held across a model call or a mail provider call.
  - `callerKindForSourceChannel("email")` MUST resolve to `human` without adding `email` to `AGENT_SOURCE_CHANNELS`.
- **New Seams Required**:
  - `InboundEmailReceiver` and `EmailDomainProvisioner` ports and Resend adapters, composed in `backend/src/app/composition/`.
  - `email` variant of `ConversationChannelContext` in `packages/conversation-contract`; OpenAPI, the `typescript-sdk` snapshot, and `packages/radioso-mcp-server` generated types regenerate in the same change.
  - `review` turn execution mode and the typed turn result on the host port.
  - Held reply record and its `release`, `edit-and-release`, `discard` operations on the inbox API, with conditional atomic release.
  - Send intent record with stable idempotency key, provider message id, delivered Message-Id, and states `queued`, `accepted`, `delivered`, `bounced`, `failed`, `uncertain`, `halted`.
  - `delivery_failed` attention kind; ownership reason `operator_only_mailbox`.
  - `email.send` outbox action and worker; inbound processing job and content-fetch retry.
  - Frontend: `email-channel` entry in `frontend/lib/agent-channel-catalog.ts`; an email channel settings card (mailboxes with relay address and forwarding instructions, receiving state and last received time, sending domain DNS records with per-record copy and status, verify, guided setup check, engagement mode, budgets, event log, advanced direct-receiving option); inbox rendering of email header facts and held-reply review actions.
  - Copilot: read-only Ray tools for email channel configuration, event log summary, and held replies. Mutations are excluded from Ray this release and the coverage map says so.
- **Anti-Goals**:
  - Do not add inbound parsing or DNS logic to `emailService.ts`; one port per file.
  - Do not add `if (sourceChannel === "email")` branches to the engine, the chat service, or the operator reply service.
  - Do not acknowledge a webhook before the event is persisted; do not process inline.
  - Do not detect automated mail, bounces, or spam with keyword lists over subjects or bodies; use RFC 3834 headers, DSN content types, and provider-computed results.
  - Do not call the Resend SDK outside `mail/adapters/`.
  - Do not create a new workspace package; existing modules and contracts are sufficient homes.
  - Do not make direct MX on a customer domain the default or only receiving path; the relay is the default.
  - Do not resolve the mailbox from the customer's own address; only a relay-domain address, wherever it appears in the envelope or headers, identifies the mailbox.
  - Do not ingest attachments or pass their content to the agent.
  - Do not reuse `backend/src/modules/customerEmail/` for channel delivery; it sends as the customer's own OAuth mailbox and is a different product surface.
  - Do not let any email transport fact populate `verified_customer_id` this release.

## Engagement Outcome Table

The single source of truth for what happens to an accepted inbound message. "Turn result" is the typed result of the host port.

| Mailbox mode | Structural gate | Turn runs | Turn result | Publication decision | Customer sees | Attention |
|---|---|---|---|---|---|---|
| any | automated_sender, self_sender, bounce, spam, participant_mismatch, no_mailbox, mailbox_disabled | no | n/a | n/a | nothing | event log; thread note where a thread exists |
| any | human-owned conversation | no | n/a | n/a | nothing until operator replies | human-owned lane |
| any | generation budget exhausted | no | n/a | n/a | nothing | human-owned with reason `generation_budget` |
| operator_only | accepted | no | n/a | n/a | nothing | human-owned with reason `operator_only_mailbox` |
| draft | accepted | review | grounded, complete, no hand-off | hold | nothing | `approval` (held reply) |
| draft | accepted | review | partial, no-context, out-of-scope, hand-off, with text | hold, outcome labelled | nothing | `approval` (held reply) |
| draft | accepted | review | no text, or unavailable | no held reply | nothing | hand-off reason from engine |
| draft, auto | accepted, reply triage finds no reply needed | no | n/a | n/a | nothing | none; thread note `no_reply_needed` |
| auto | accepted, send budget has room | review | grounded, complete, no hand-off, completeness check finds it complete | publish | agent email | none |
| auto | accepted, send budget has room | review | grounded, complete, no hand-off, completeness check finds it partial, not answered, or unavailable | hold, reason `incomplete_answer`, coverage labelled | nothing | `approval` |
| auto | accepted, send budget exhausted | review | any | hold, reason `send_budget` | nothing | `approval` |
| auto | accepted | review | anything but grounded-complete-no-hand-off | hold, outcome labelled | nothing | `approval` |

## State Machines

- **Review (held reply)**: `pending` → `released` | `edited` | `discarded` | `superseded`. Release is conditional on the record still being `pending` and on the conversation's ownership version and the mailbox policy version matching those the draft was bound to. A newer inbound, an operator free-form reply, a takeover, a downgrade to `operator_only`, or any agent or enabled change moves `pending` or `queued_auto` to `superseded`. A downgrade from `auto` to `draft` returns `queued_auto` to `pending` with reason `policy_changed` and re-binds pending drafts to the new policy version, so they stay reviewable.
- **Ownership**: existing `ai_owned` | `human_owned`. Operator-only mailboxes create conversations `human_owned` with reason `operator_only_mailbox`. Releasing a held reply, edited or not, does not change ownership. A free-form operator reply or takeover does, as today.
- **Delivery (send intent)**: `queued` → `accepted` → `delivered` | `bounced`; `queued` → `failed` | `halted`; `accepted` → `uncertain` when no provider event settles it inside the reconciliation window. `uncertain` resolves only by reconciliation against the provider or an audited operator decision.
- **Sending domain**: readiness `pending` | `verified` | `failed`, refreshed on a bounded cadence and on provider events. Removal revokes authority first, halts queued sends, preserves history, and reconciles provider state asynchronously. A receiving domain (advanced) tracks the same states for receiving.
- **Mailbox receiving**: `waiting_for_first_message` | `ok` | `silent`, derived from the last received time and the mailbox silence threshold; purely informational, because forwarding breakage is invisible to Radioso.

## Requirements *(mandatory)*

### Functional Requirements

**Mailboxes and domains**

- **FR-001**: An operator with workspace settings permission MUST be able to add a mailbox by its real address, bind it to an agent, and receive an opaque relay address on the deployment's inbound domain with forwarding instructions; each mailbox MUST carry a display name, engagement mode, enabled flag, thread send budget, hourly generation budget, and silence threshold, all with safe defaults.
- **FR-002**: The deployment's inbound domain MUST be configuration, provisioned once per deployment; relay tokens MUST be opaque, high-entropy, unique per mailbox, and rotatable by the operator, and the mailbox MUST be resolved only from the relay token on the delivered-to address.
- **FR-003**: Adding a mailbox MUST register its address's domain as a sending domain for the workspace if not already present and show the DKIM, SPF, and DMARC records with per-record copy and status; a sending domain MUST be unique across workspaces, MUST refresh readiness on a bounded cadence and on provider events, and MUST emit audit events on readiness changes.
- **FR-004**: A mailbox MUST accept inbound regardless of sending readiness; until its sending domain is verified, agent-authored replies MUST be held with reason `sending_not_verified` and operator replies MUST be refused before any write with the missing step named.
- **FR-005**: Engagement mode MUST be one of `operator_only`, `draft`, `auto`, defaulting to `draft`.
- **FR-006**: Each mailbox MUST record its last received time and expose a receiving state of waiting, ok, or silent; a guided setup check MUST prove the forward path by waiting for a message the operator sends to the real address.
- **FR-006a**: Direct receiving on a customer-owned domain or subdomain MUST be available as an advanced option that names the consequence that all mail for that domain routes to Radioso, requires typed confirmation, and tracks receiving readiness separately; it MUST NOT be the default path.
- **FR-006b**: Sending or receiving domain removal MUST revoke authority first, halt queued sends, preserve conversations and history, and reconcile provider state asynchronously.

**Inbound**

- **FR-007**: The webhook MUST verify the provider signature through the receiver port and MUST persist the verified event and a processing obligation atomically before responding; it MUST do no other work inline.
- **FR-008**: A worker job MUST fetch content for each event with bounded retry, normalize it, classify it, resolve its thread, and run the engagement disposition; terminal failures MUST be visible in the event log with a retry action.
- **FR-009**: Provider-event deduplication and per-mailbox processing idempotency MUST be separate; one message addressed to several bound mailboxes MUST produce one processing unit per mailbox.
- **FR-010**: Both inbound and Radioso-generated Message-Ids MUST be recorded per mailbox; thread resolution MUST match `In-Reply-To` and `References` against them and the plus-address token, scoped to the destination mailbox and workspace, in that order, and MUST record conflicting matches as an operator-visible exception.
- **FR-011**: A resolved thread whose sender is not the conversation's participant MUST be recorded as `participant_mismatch`, attached as an operator-visible exception, and MUST NOT run a turn.
- **FR-012**: The `email` channel context MUST hold only stable identity: mailbox, thread key, participant address. Subject, display name, CC list, and envelope facts MUST live on messages and events, with a latest projection for the inbox header.
- **FR-013**: The customer message text MUST be the plain-text body or HTML converted to text, with quoted history and signatures stripped only when the parser is confident; the stored raw body MUST be the content itself, not a provider link.
- **FR-014**: Attachments MUST be recorded by name, type, and size, MUST NOT be ingested or passed to the agent, and operators MUST be able to open the stored raw message.
- **FR-015**: Classification MUST derive `automated_sender` from `Auto-Submitted`, `Precedence`, `X-Auto-Response-Suppress`, and `List-Id`; `bounce` from a delivery status report naming a Radioso outbound Message-Id; `self_sender` from the workspace's mailboxes and relay addresses; `spam` from the provider's verdict with `unknown` treated as not spam; none of these MUST run a turn. Provider authentication results MUST be recorded on the event and MUST NOT drop a message on their own, because forwarded mail routinely fails SPF.
- **FR-016**: Every accepted event that does not open a conversation MUST be visible in the mailbox's event log with disposition, sender, subject, and time, under a bounded retention.

**Engagement**

- **FR-017**: The engagement disposition MUST be a pure function of mailbox mode, classification, ownership state, participant match, and budgets, returning `ingest_only`, `run_review_turn`, or `drop` with a reason.
- **FR-017a**: On a `draft` or `auto` mailbox, after the generation budget is reserved and before the review turn runs, a structured model call MUST read the customer's mail since the business last wrote plus up to six earlier messages and return a reply-needed verdict of `yes`, `no`, `unsure`, or `unavailable` (model error, timeout, invalid output, or no incoming customer mail). Only `no` MUST silence the revision: no review turn, no held reply, no attention item, no hand-off, and the thread send budget MUST NOT be consumed; the revision MUST complete with an operator-visible thread note (`channel_exception` detail code `no_reply_needed`, naming the newest customer message's delivery) and no other outcome. `yes`, `unsure`, and `unavailable` MUST run the review turn as if triage had not run. The triage MUST NOT run on an `operator_only` mailbox, when the generation budget is exhausted, or on a human-owned conversation.
- **FR-018**: `operator_only` MUST run no turn and MUST create or continue the conversation as human-owned with reason `operator_only_mailbox`.
- **FR-019**: Every email turn MUST run in `review` execution mode: durable, externally visible skill effects suppressed, routines not activated, hand-off and coverage signals recorded, output returned to the caller and never persisted as an assistant message.
- **FR-020**: The publication decision MUST be a pure function of the typed turn result, mailbox mode, send budget, ownership, sending readiness, the list of suppressed skill effects, and a completeness verdict, returning `publish` only for an `auto` mailbox with a grounded, complete, non-hand-off result, budget room, sending ready, no suppressed effect, and a `complete` verdict from the email completeness check, and `hold` with a reason otherwise; it MUST fail closed on unknown or unavailable results. The completeness check MUST run only when every other gate would publish, at most once per candidate, reading the candidate reply and the passages the turn drew on.
- **FR-021**: A human-owned conversation MUST NOT run a turn on inbound email, regardless of mode.
- **FR-022**: Each thread MUST have an automatic send budget, defaulting to three, that customer input never resets and that an operator reply or a held-reply release on the thread renews; reaching it MUST hold the next candidate reply with reason `send_budget`.
- **FR-023**: Each mailbox MUST have a generation budget over a fixed one-hour window anchored at its first generation; when reached, accepted inbound MUST be ingested as human-owned with reason `generation_budget`.
- **FR-024**: Inbound messages on one thread inside a fixed 60-second coalescing window MUST produce one review turn; the review turn's thread context MUST be bounded to the thread's 10 newest messages; a terminal review failure MUST hand off with reason `review_unavailable`.
- **FR-025**: A downgrade from `auto` to `draft` MUST halt unsent automatic sends and hold them for review, re-binding pending drafts to the new policy version; a downgrade to `operator_only` MUST supersede them; an upgrade MUST apply only to inbound accepted after the change and supersedes drafts bound to the old policy.
- **FR-026**: Operators MUST be able to author finer engagement rules as directives; no email-specific rule text MUST exist in code or prompts.

**Held replies**

- **FR-027**: A held reply MUST be visible to operators with the turn outcome, reasoning, and any suppressed-action dependency, and MUST NOT appear in customer-visible history.
- **FR-028**: Operators MUST be able to release, edit-and-release, or discard a held reply; release MUST be an atomic conditional operation that creates at most one send intent and MUST emit an audit event naming the operator; author, editor, and releaser MUST be recorded separately.
- **FR-029**: Release, edited or not, MUST NOT change conversation ownership; an unchanged release delivers as an agent message, an edited release as an operator message with the original retained.
- **FR-030**: A newer inbound, a free-form operator reply, a takeover, or a downgrade to `operator_only` MUST supersede a pending held reply; a downgrade from `auto` to `draft` MUST keep it reviewable per FR-025. Every conversation whose live draft a policy change supersedes and that is still AI-owned MUST become human-owned in the same transaction, recording `handoff_requested`: with reason `operator_only_mailbox` when the new policy reviews no mail (`operator_only`, disabled, or no agent), and `policy_changed` otherwise (an upgrade, another agent).

**Outbound**

- **FR-031**: Every outbound email MUST originate as an `email.send` outbox action carrying a stable idempotency key. For operator replies and released held replies the action MUST be written in the same transaction as the message it delivers. For automatic replies the action MUST reference the held-reply record, and the customer-visible message row MUST be written only at dispatch after re-authorization succeeds, so held content never exists as a message row before it is sent. The worker MUST materialize the send intent under the key on first dispatch and send through `EmailDriver` with at-least-once retry reusing the key.
- **FR-032**: Before calling the provider the worker MUST revalidate mailbox mode and enabled flag, domain sending readiness, ownership, and send budget, and MUST hold instead of send if any changed.
- **FR-033**: Every outbound email MUST set `From` to the mailbox's real address and display name, a Radioso-generated `Message-Id` on the sending domain, `In-Reply-To` and `References` from the thread, `Reply-To` to the mailbox's real address with an opaque high-entropy plus-address thread token so the customer's reply travels through their forward, and a subject continuing the thread; header values MUST be typed and MUST reject CR, LF, and malformed identifiers.
- **FR-034**: Agent-authored emails MUST carry `Auto-Submitted: auto-generated`; operator-authored emails MUST NOT.
- **FR-035**: The provider message id and the Message-Id as delivered MUST be recorded on the send intent; the plan MUST verify the provider preserves the supplied Message-Id and define reconciliation if it does not.
- **FR-036**: Send state MUST follow the delivery state machine; bounces MUST be consumed from provider events as well as inbound DSNs; `uncertain` sends MUST never be resent without an audited operator decision.
- **FR-037**: A `bounced`, `failed`, or `uncertain` send MUST flag the conversation with attention kind `delivery_failed` and show sanitized failure detail on the message.

**Operator inbox and attention**

- **FR-038**: Email conversations MUST appear in the inbox through the same list, filters, ownership, takeover, and hand-back operations as other channels, with sender, subject, and mailbox in the header.
- **FR-039**: Operator replies MUST route through `CustomerReplyDeliveryDispatcher` to the email deliverer; web-only conversations MUST be unaffected.
- **FR-040**: Attention MUST reuse `approval` for held replies and human ownership for operator-only and budget-exhausted conversations, and MUST add `delivery_failed` as a shared kind; each kind MUST define what creates, clears, and reopens it.
- **FR-041**: Email conversations MUST NOT auto-close.
- **FR-042**: The settings and inbox surfaces MUST define loading, empty, error, success, and partial states for domain setup, mailbox setup, draft review, delivery status, and the event log, and MUST keep keyboard focus and announce async status after review actions.

**Contracts, docs, observability, security**

- **FR-043**: The `email` channel context MUST be added to the conversation contract, OpenAPI, the SDK snapshot, and the MCP generated types in the same change.
- **FR-044**: Documentation MUST be added or updated: `docs/email-channel.md` (including supported DNS topology and forwarding), `docs-portal/content/operators/email-channel.mdx`, `docs/human-takeover.md`, `docs/architecture/code-map.md`, the product-docs corpus resync, the queue docs, and the readme channel list.
- **FR-045**: No log, metric, trace, or audit payload MUST contain subjects, bodies, addresses, raw headers, thread tokens, prompts, or completions, across every mail driver and worker.
- **FR-046**: Raw bodies MUST be retained under the conversation's retention and deletion lifecycle with stricter access and a size cap; operator rendering MUST be sanitized with remote resources disabled.
- **FR-047**: Read-only Ray tools MUST cover email channel configuration, event log summary, and held replies; mutations MUST be excluded and the coverage map MUST say so.

### Key Entities

- **Sending domain**: a customer-owned domain verified for sending on behalf of one workspace; provider domain id, DNS records, readiness, last refresh. A receiving domain (advanced) is the same record with receiving readiness.
- **Mailbox**: the customer's real address bound to an agent; relay token on the deployment's inbound domain, display name, engagement mode, enabled flag, thread send budget, hourly generation budget, silence threshold, last received time.
- **Inbound event**: one verified provider delivery; provider event id, mailbox, processing state, disposition, raw content, received-at. The audit trail for every email that touched the system.
- **Thread message id**: an RFC Message-Id seen or generated for a mailbox, with direction and conversation.
- **Thread link**: a conversation's mailbox, participant address, and opaque thread token.
- **Send intent**: one outbound email; idempotency key, provider message id, delivered Message-Id, delivery state, authority snapshot.
- **Held reply**: an agent-authored reply awaiting operator action; review state, bound inbound revision, ownership version, policy version, turn result, author, editor, releaser.
- **Engagement disposition** and **publication decision**: the typed results of the two pure gates.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator connects a mailbox and passes the setup check in one settings session with the external steps their mail service requires (a forwarding rule; for Microsoft 365 also the tenant policy change; for Google also the confirmation code); sending verifies in the same session once the DNS records are published.
- **SC-002**: Against the committed threading corpus (first-contact, pre-reply follow-up, header-threaded reply, token-only reply, two-mailbox message, participant mismatch, duplicate event), every case resolves to the expected conversation.
- **SC-003**: Against the committed protocol fixture set (each RFC 3834 header, DSN report, self-sender, provider spam and auth-failed verdicts, unknown verdict), zero fixtures run a turn and every fixture appears in the event log.
- **SC-004**: On a `draft` mailbox, zero send intents exist for any held reply in `pending`, and no held reply text appears in customer-visible history endpoints.
- **SC-005**: On an `auto` mailbox, every non-publish row of the outcome table produces a held reply or hand-off flag and no send intent, in the deterministic eval suite.
- **SC-006**: A simulated headerless responder on an `auto` mailbox stops at the thread send budget with one attention flag; a flood of unique first-contact messages stops generation at the mailbox budget with nothing lost.
- **SC-007**: Killing the worker at every stage boundary of inbound processing and outbound sending, then restarting, yields exactly one conversation message and at most one provider accept per intent.
- **SC-008**: Webhook acknowledgment p99 under one second; receipt to inbox p99 under thirty seconds; receipt to held reply p99 under ninety seconds under the stated budgets.
- **SC-009**: Email conversations appear in the inbox, triage, and needs-attention views with no email-specific filter, and the three attention paths each clear on their defined event.

## Non-Goals

- Routine activation and multi-turn routine execution from email. A follow-up spec defines a batching policy for routine asks over email.
- Reading a mailbox's history as a knowledge source, or ingesting attachments.
- Direct MX on a customer's root domain as a default or guided path.
- IMAP or SMTP polling; inbound is provider webhook on the relay domain only.
- Merging identities across channels or across a person's addresses; multi-party threads.
- Sending to CC or multiple recipients.
- Rich HTML templates; outbound is plain text with a minimal HTML alternative.
- Auto-closing email conversations.
- Held-reply review for Slack or web conversations; the concept is channel-neutral but email proves it first.
- A forwarding setup wizard; the supported topology is documented instead.

## Assumptions

- Resend offers inbound webhooks with content fetch, a domains API with separate receiving and sending status, idempotency keys, and bounce events on the plans Radioso Cloud and self-hosters use. The plan MUST verify each before building on it; the ports let a self-hoster swap providers without touching channel code.
- The provider preserves a supplied `Message-Id`; if not, reconciliation uses the delivered id per FR-035.
- Radioso Cloud operates one inbound relay domain per region; self-hosters point their own inbound domain at the provider and set it in `.env`.
- Plus addressing is not assumed. The plus-token `Reply-To` is enabled per mailbox only after a setup-check step proves the customer's mail service forwards plus-addressed mail; until then `Reply-To` is the plain address and Message-Id threading stands alone.
- Resend exposes SPF, DKIM, and DMARC results but no spam verdict; with Resend the `spam` disposition never triggers and is covered by fixtures for other providers.
- Resend region support for receiving is unverified; EU rollout is blocked until inbound content is confirmed to be processed in an EU region or an explicit decision accepts otherwise.
- Forwarded mail arrives with the original sender in `From`, the original recipient in `To`, and the relay address as delivered-to; SPF failures on forwarded mail are expected.
- The existing operator reply unit of work (message and outbox in one transaction, conversation and ownership locked) is the model for release and auto-send.
- Email conversations count toward conversation metering like any other channel.
- The operator inbox spec (`specs/1116-operator-inbox/`) is the surface where held replies and email headers render; this spec adds to it.

## Observability

New runtime paths: webhook receipt, inbound processing job, engagement disposition, reply triage, review turn, completeness check, publication decision, held-reply lifecycle, send intent and `email.send` job, domain readiness refresh. Counters: events by disposition, turns by mode and outcome, `email_reply_triage_total` by verdict, `email_completeness_checks_total` by verdict, publication decisions by reason, sends by state, budget hits, domain readiness transitions. Spans around webhook verification, content fetch, thread resolution, review turn, `email.review.reply_triage`, `email.review.completeness`, provider send. Audit events for domain and mailbox lifecycle and held-reply actions. Alerts: inbound events stuck past the processing deadline, persistent provider authentication failure, `uncertain` sends accumulating, domain readiness lost. A backlog dashboard for events and send intents by state. Runbooks: provider outage, webhook signing-key rotation, stuck event replay, bounce spike. Nothing logs subjects, bodies, addresses, tokens, raw headers, prompts, or completions.

## Message-Queue Impact

New durable inbound processing job keyed by inbound event with content-fetch retry and a terminal failure state. New outbox action `email.send` with a worker handler, at-least-once retry on a stable idempotency key, and authority revalidation before dispatch. No change to document worker dispatch or AMQP payloads. Queue docs gain both.

## Rollout and Rollback

Additive schema first; workers deployed disabled; settings and inbox APIs; provider credentials and the inbound relay domain per region; an `operator_only` pilot on one forwarded mailbox; operator sending once its domain verifies; `draft`; `auto` only after a workspace has reviewed drafts and the outcome table has passed the deterministic suite. Rollback disables workers and mailboxes, never drops the new tables, and never replays `uncertain` sends.

## Testing Shape

Many pure unit tests for classification, disposition, publication decision, threading resolution, header serialization, and state transitions. Fewer integration tests for the inbound job, release atomicity, send idempotency, and crash-at-boundary recovery. Few Playwright journeys: domain setup, mailbox binding, draft review, operator reply. Contract tests for the webhook and the host port. Email rows added to the deterministic conversation eval suite. CI never depends on DNS, an external mailbox, or live model behavior.

## Decisions for the User

Defaults applied in this revision, per the CEO review's recommendations. Confirm or override before planning.

1. **Topology** (confirmed 2026-10-03): relay by default. The customer forwards their real mailbox to a Radioso-provided relay address and verifies sending on their own domain; direct MX on a customer domain is an advanced, confirmed option.
2. **Skill effects**: suppressed for every email turn this release, including `auto`.
3. **Non-grounded outcomes**: held with the outcome labelled when there is text; no draft when there is none.
4. **Release and ownership**: releasing a draft never takes ownership; a free-form reply or takeover does.
5. **Loop bound**: three automatic sends per thread between operator renewals, never reset by customer input, plus an hourly generation budget per mailbox.
6. **Identity**: `verified_customer_id` stays null; thread continuation requires the original participant; mismatches are operator-visible exceptions.
7. **Spam**: always a bounded event record; no opt-in, and no turn or conversation ever follows a spam verdict.
8. **`operator_only`**: no turn at all.
9. **Mode downgrade**: halts unsent automatic work; upgrades apply to new inbound only.
10. **Uncertain sends**: reconcile or audited operator decision; never blind resend.
11. **Domain removal**: revoke authority first, preserve history.
12. **Ray**: read-only tools; mutations excluded this release.
13. **Raw bodies**: retained under conversation retention with stricter access and a size cap.
14. **Included small expansions**: guided setup check; per-record DNS copy and status.
15. **`auto` in this release** (confirmed 2026-10-03): kept as the last story behind the outcome table and rollout gates.

## Deferred

- Original-versus-edited draft comparison view.
- Aging reminders for stale held replies.
- Keyboard shortcuts for review.
- Per-mailbox autonomy-readiness report; never auto-promotes a mailbox.
- Held-reply review on Slack and web.
- Forwarding setup wizard.
- Routine batching policy for email.

## Review History

- 2026-10-03: adversarial challenge review (12 blocking, 6 non-blocking findings) and plan-ceo-review in selective-expansion mode, both run on the first draft. Their baseline corrections and two accepted expansions are folded in above; the rest are listed under Deferred. Review transcripts are kept outside the repository.
- 2026-10-03: topology changed from a customer-owned receiving subdomain to relay-by-default after discussion; `auto` confirmed as the gated last story.
