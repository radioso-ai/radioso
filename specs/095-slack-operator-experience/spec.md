# Feature Specification: Slack operator experience (act on escalations from Slack + real Slack metadata in Activity)

**Feature Branch**: `slack-rich-integration`  
**Created**: 2026-06-23  
**Status**: Approved (owner: dmitri@ausalt.com, 2026-06-23)  
**Input**: User description: "Slack skills are basic and the UX is lacking. I want the full thing: (1) the agent notifying in channels, with being able to approve / handoff / deny / talk to customer and other actions in Slack; (3) being able to see Slack metadata in Activity — currently Slack shows up as 'authenticated chat'."

> Design source of truth: `.context/slack-full-experience-design.md` (decisions, rejected alternatives, path:line evidence). Builds on shipped Spec 092 (`092-slack-channel`) and Spec 091 (`091-human-in-the-loop-approvals`). The "save a Slack message as a document" idea from the same request is intentionally carved out into a **separate** feature (Spec 096, Slack as a document source) because it is LLM-interpreted ingestion, not operator actions.

## Framing

Spec 092 made Slack a **front door** (customers talk to the agent) and an **escalation surface** (the agent posts plain text to a human channel on a gap). Today that escalation is a dead-end note: a human reads it in Slack, then must leave Slack, open the dashboard, find the conversation, and act there. And in the dashboard Activity view, a Slack conversation is indistinguishable from a signed-in web chat — it reads as "authenticated chat" with no team / channel / thread / user context.

This feature closes both gaps **without duplicating any HITL domain logic**:

1. **Act on Slack.** Operator-relevant events (an automatic gap escalation, a routine approval gate, a routine handoff) arrive in a configured Slack **operator channel** as interactive Block Kit messages. From the message an operator can **Approve / Deny** a decision, **Take over / Hand back** a conversation, and **Talk to the customer** — each action resolved through the *existing* approvals and conversation-ownership services, attributed to the real human who clicked. The message then updates in place to show the outcome.

2. **See Slack in Activity.** A Slack conversation carries typed channel context (team, channel, channel type, thread, Slack user) that the Activity view renders as a real "Slack" badge with that context — replacing the misleading "authenticated chat" label.

Two existing seams make this honest rather than bolted-on:

- **Slack is already an inbound adapter and an outbound `slack.post` outbox action.** We add an **inbound interactivity adapter** (Slack button/modal callbacks) and **interactive (Block Kit) posting**, reusing the same signature verification, installation lookup, and outbox.
- **The HITL domain already exposes the operator actions** (`ApprovalDecisionService.resolve`, conversation-ownership `takeover` / `reply` / `handback`, the `approval.request` / `handoff.notify` outbox actions). Slack becomes a new **delivery sink** and a new **inbound caller** of those services; it does not re-implement them.

**Deliberately out of scope:** LLM-interpreted "save this message as a document" (Spec 096); transferring a conversation to a *specific other* operator from Slack (dashboard-only for now — Slack take-over/hand-back is enough); managing Slack threads as a knowledge source.

## User Scenarios & Testing *(mandatory)*

Stories are sliced so each is independently shippable. Priority order: prove the inbound interactivity keystone with the highest-value action (approve/deny a decision) first; then the ownership actions including "talk to customer"; then unify all operator events into one interactive channel; then surface Slack context in Activity.

### User Story 1 — Approve or deny a decision from inside Slack (Priority: P1)

A routine reaches an approval gate ("Approve sending the refund?"). Instead of only emailing the operator, Radioso posts an interactive message to the workspace's Slack operator channel with the reason and **Approve / Deny** buttons. An operator who is a member of the Radioso workspace clicks **Approve**; the decision resolves exactly as it would from the dashboard, the routine resumes, and the Slack message updates in place to "✅ Approved by Dana — routine resumed." A non-member who clicks gets a private (ephemeral) "you're not an operator on this workspace" reply and nothing is resolved.

**Why this priority**: This is the keystone of "act on Slack." It forces the whole inbound interactivity substrate into existence (manifest interactivity + scopes, signed interactivity webhook, Slack-user → operator-account identity link, Block Kit builder, message update) and wires it to the single most valuable action — resolving a pending decision — through the existing `ApprovalDecisionService` without duplication.

**Independent Test**: With a mock Slack (mock OAuth/install, stubbed Slack Web API, signed interactivity payloads): drive a routine to an approval gate for a Slack-connected workspace; assert an interactive message with Approve/Deny was enqueued to the operator channel via the outbox and posted (Block Kit, not plain text); POST a signed `block_actions` payload for **Approve** from a Slack user whose email matches a workspace member; assert the pending decision resolved to `approved` with the resolving account recorded, the routine resumed, and a chat.update replaced the buttons with the outcome. Repeat with a stale `contentHash` (assert no double-resolve), with a non-member Slack user (assert ephemeral rejection, decision still pending), and with a forged signature (assert 401, nothing resolved).

**Acceptance Scenarios**:

1. **Given** a Slack-connected workspace with an operator channel configured and a routine that reaches an approval gate, **When** the gate is created, **Then** an interactive Block Kit message (reason + option buttons) is delivered to the operator channel through the outbox, and the dashboard decision still exists unchanged.
2. **Given** that message, **When** a workspace-member operator clicks **Approve**, **Then** the decision resolves to `approved` via the existing approvals service, the routine resumes, the resolving operator is recorded, and the Slack message updates in place to show who approved and that it resumed.
3. **Given** that message, **When** a Slack user who is not a workspace member (or lacks the takeover permission) clicks a button, **Then** they receive an ephemeral rejection, the decision stays `pending`, and no audit "resolved" event is written.
4. **Given** a decision already resolved (in the dashboard or by a faster click), **When** an operator clicks a now-stale button, **Then** the action is rejected without changing the outcome and the Slack message reflects the already-resolved state.
5. **Given** any interactivity callback, **When** it arrives, **Then** the request signature and timestamp are verified (forged/stale rejected) before any resolution, identically to the events webhook.

---

### User Story 2 — Take over, talk to the customer, and hand back from Slack (Priority: P2)

A gap escalation lands in the operator channel: "Slack customer asked X; no grounded answer." The message has **Take over**, **Talk to customer**, and a link to open the conversation in the dashboard. An operator clicks **Take over** (the conversation becomes human-owned and the AI stops auto-replying), then **Talk to customer**, which opens a Slack modal; they type a reply and submit. The reply is persisted as a human-agent message and delivered to wherever the customer is — back into the customer's Slack DM/thread if the conversation originated in Slack, or into the live web chat if it originated on the website. When finished, the operator clicks **Hand back to AI**.

**Why this priority**: This is the "handoff / talk to customer" half the user explicitly asked for, and the part that makes Slack a real operator console rather than a notifier. It reuses the conversation-ownership domain (`takeover` / `reply` / `handback`) and the version-locked optimistic concurrency already in place, and it exercises channel-aware outbound delivery of a human reply.

**Independent Test**: For a Slack-origin conversation: deliver an interactive escalation; POST signed `Take over` → assert ownership flips to `human_owned` with the operator as owner and version incremented; POST `Talk to customer` (modal open) then a signed `view_submission` with reply text → assert a message persisted with `source="human_agent"` + `metadata.humanAgent`, and a `slack.post` enqueued to the **customer's** DM/thread (not the operator channel); POST `Hand back` → assert ownership returns to `ai_owned`. Repeat the reply for a **web-origin** conversation → assert the human reply surfaces via the existing web reply path and no customer-facing Slack post is enqueued. Assert a stale `version` (someone else took over) is rejected and the Slack message refreshes.

**Acceptance Scenarios**:

1. **Given** an interactive escalation/handoff message, **When** an operator clicks **Take over**, **Then** the conversation becomes `human_owned` owned by that operator, AI message-emitting resumes are deferred, and the message updates to show the owner with **Talk to customer** / **Hand back** available.
2. **Given** a human-owned Slack-origin conversation, **When** the operator submits a reply via the **Talk to customer** modal, **Then** the reply is stored as a `human_agent` message and delivered into the customer's original Slack DM/thread.
3. **Given** a human-owned web-origin conversation, **When** the operator submits a reply, **Then** the reply is stored as a `human_agent` message and appears in the customer's web chat (no Slack customer post).
4. **Given** a human-owned conversation, **When** the operator clicks **Hand back to AI**, **Then** ownership returns to `ai_owned` and the AI may answer subsequent turns.
5. **Given** another operator already took the conversation over, **When** an operator acts on a stale version, **Then** the action is rejected and the Slack message refreshes to the current owner/state.

---

### User Story 3 — One interactive operator channel for gaps, approvals, and handoffs (Priority: P3)

An operator configures a single Slack **operator channel** for a workspace. From then on, every operator-relevant event — an automatic gap escalation, a routine approval gate, and a routine handoff — arrives there as an interactive message with the actions appropriate to that event type, alongside the dashboard's existing email/webhook notifications. The operator never has to wonder where a given kind of event shows up.

**Why this priority**: Gap escalation already posts to Slack (Spec 092), but approvals and handoffs only email/webhook. This story introduces the operator-notification delivery seam so all three event types reach Slack interactively and consistently, and is what makes US1/US2 trigger from real product events rather than only the gap path. It is P3 because US1/US2 can be demoed via the gap path alone; this generalizes delivery.

**Independent Test**: With a workspace that has an operator channel configured: trigger each event type (gap → no grounded answer; approval gate; routine handoff) and assert each enqueues an interactive Slack message to the operator channel **in addition to** the existing email/webhook delivery, with the correct action set per type (approve/deny for approvals; take over / talk / hand back for handoffs and gaps), all through the shared outbox + Slack Web API client. Assert that a workspace **without** Slack configured still gets email/webhook and no Slack attempt is made.

**Acceptance Scenarios**:

1. **Given** a workspace with a configured Slack operator channel, **When** a routine reaches an approval gate, **Then** an interactive approve/deny message is delivered to the operator channel and the existing email/webhook notifications still fire.
2. **Given** the same workspace, **When** a routine hands off (or a turn yields no grounded answer), **Then** an interactive take-over/talk/hand-back message is delivered to the operator channel and existing notifications still fire.
3. **Given** a workspace with no Slack connection, **When** any of those events occur, **Then** email/webhook delivery is unchanged and no Slack delivery is attempted or errors.
4. **Given** the operator channel is the same channel used for gap escalation today, **When** all three event types occur over time, **Then** they all land in that one channel with type-appropriate actions.

---

### User Story 4 — See real Slack context in Activity (Priority: P3)

In the dashboard Activity view, a conversation that came from Slack shows a **Slack** badge and its real context — the Slack workspace/team, the channel (or "Direct message"), the thread, and the Slack user — instead of being lumped in as "authenticated chat." Opening the conversation shows the same context in the detail drawer.

**Why this priority**: This is a direct, self-contained ask ("currently I see Slack as authenticated chat"), needs no Slack app re-consent, and can ship independently of the interactivity work. It also provides the conversation **channel origin** that US2 uses to route a human reply back to the right place.

**Independent Test**: Create a Slack-origin conversation (DM and channel-mention variants) and assert the conversation persists typed channel context (provider=slack, teamId/teamName, channelId/type, threadTs, slackUserId/name). Call the history list + detail API and assert the channel context is returned. In a Playwright test, assert the Activity row renders a "Slack" badge with channel/thread/user context and the detail drawer shows it; assert a web/authenticated conversation is unaffected.

**Acceptance Scenarios**:

1. **Given** a customer DM in Slack, **When** the conversation appears in Activity, **Then** it shows a "Slack" badge labeled as a direct message with the Slack user, not "authenticated chat."
2. **Given** an @mention in a Slack channel, **When** the conversation appears in Activity, **Then** it shows the Slack channel and thread context.
3. **Given** a Slack conversation, **When** an operator opens its detail drawer, **Then** the Slack team/channel/thread/user context is shown.
4. **Given** a website-embed or authenticated web conversation, **When** it appears in Activity, **Then** its label is unchanged by this feature.

---

### Edge Cases

- **Operator identity is ambiguous or absent**: Slack user has no email visible (scope/consent), email matches no workspace member, or matches a member lacking `workspace.conversation.takeover` → ephemeral rejection, no resolution, no leaked detail about who *is* an operator.
- **Double-action / race**: two operators click the same button, or someone resolved it in the dashboard first → exactly one resolution wins (existing `content_hash` for decisions, `version` for ownership); the loser's Slack message refreshes to the real state.
- **Slack message lifecycle**: the original interactive message is deleted, in a channel the bot was removed from, or the `chat.update` fails → action still resolves server-side; update failure is logged and retried best-effort, never blocks resolution.
- **Customer reply delivery failure** (Slack-origin): customer DM closed / bot removed / token needs reauth → human reply is still persisted; outbound customer post retries via outbox and surfaces a delivery-failure indication to the operator.
- **Talk-to-customer on an AI-owned conversation**: operator tries to reply before taking over → either auto-takes-over-then-replies or instructs them to take over first (decide in plan; must not create an orphan human message on an AI-owned thread).
- **Workspace not Slack-connected** (US3): no Slack attempt; email/webhook unchanged.
- **Interactivity disabled / app not re-consented**: clear operator-facing status that Slack must be re-installed to enable actions; events/answering keep working.
- **Replay/forgery**: interactivity callbacks reuse the same signature + timestamp replay-window verification as the events webhook; duplicates are idempotent.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend in Node.js/Express, frontend in React/Next.js; PostgreSQL + `pgvector` unchanged.
- No new runtime LLM prompt is required by this feature (operator actions and replies are human-authored). Any future conversational copy stays LLM-generated; this spec MUST NOT introduce hard-coded English product strings for routing or behavior (operator identity, action routing, and channel-origin are structured metadata, never keyword parsing).
- Backend changes follow TDD: failing tests first.
- Frontend user-visible behavior (Activity Slack badge/drawer) prefers Playwright; unit tests stay on logic (channel-context mapping/formatting), not markup.
- New Slack scopes and any signing material stay in `.env`; update `.env.example`. No tokens/secrets in UI, logs, or responses.
- Admin/dashboard UI uses the shared dark theme + existing tokens.
- Preserve transport/orchestration/domain/persistence boundaries; identify files that must stay responsibility-limited (below).

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Transport (inbound)* — a new Slack **interactivity adapter** (`backend/src/modules/connectors/plugins/slack/`) verifies the signature, parses the Slack interactivity `payload`, and routes by callback type. It owns NO HITL logic.
  - *Transport (outbound)* — interactive (Block Kit) posting reuses the existing `slack.post` outbox + `SlackWebApiClient`; the payload schema gains a structured `blocks`/interactive variant.
  - *Orchestration* — a thin **Slack action resolver** maps a decoded Slack action → the existing approvals / conversation-ownership services, after resolving the operator identity. It translates and authorizes; it does not implement decision or ownership rules.
  - *Domain* — `ApprovalDecisionService`, conversation-ownership service, and the document/decision invariants are unchanged and remain the single source of truth.
  - *Persistence* — operator identity link is a new narrow table/repository; conversation channel context persists on the conversation (new typed field), written by the connector at conversation creation.
- **Encapsulation Rule**:
  - The Slack message handler / webhook routers stay transport-only (no HITL rules).
  - The HITL domain services MUST NOT learn about Slack, Block Kit, or Slack identities — Slack reaches them only as another authorized caller and another delivery sink.
  - `chatHistoryService` / history routes MUST NOT query Slack tables; the activity view reads typed channel context off the conversation, not by joining `slack_conversation_links`.
- **New Seams Required**:
  - `OperatorNotificationChannel` port (sinks: existing email + webhook, plus a new **Slack interactive** sink) so `approval.request` / `handoff.notify` / gap delivery fan out without each handler knowing Slack. The Slack sink owns Block Kit construction.
  - Slack **interactivity router** + `SlackInteractivityHandler` (inbound adapter).
  - `SlackOperatorIdentityResolver` + `slack_operator_identities` persistence (team_id + slack_user_id → account_id, lazily linked by email).
  - Block Kit **message builder** keyed by event type + action set (presentation, Slack-module-owned).
  - Typed `ConversationChannelContext` (discriminated union) in `@radioso/conversation-contract`, supplied by connectors via the chat `sourceContext` and persisted on the conversation; consumed by the history presenter and frontend.
  - Channel-aware **customer reply delivery** for human-agent replies (Slack-origin → customer DM/thread post; web-origin → existing web path).
- **Anti-Goals**:
  - Do NOT re-implement approve/deny or ownership state machines in the Slack adapter.
  - Do NOT add Slack-specific columns to `conversations` or Slack joins to history; use the typed channel-context field.
  - Do NOT parse Slack/assistant text to decide actions or routing (no English keyword lists).
  - Do NOT attribute Slack actions to a generic service/owner account when a real operator can be resolved.
  - Do NOT block decision/ownership resolution on Slack `chat.update` success.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Slack app manifest MUST enable interactivity (request URL = a new Slack interactivity endpoint) and add the scopes required for operator identity (`users:read`, `users:read.email`). Self-host manifest + `.env.example` MUST be updated; re-install/re-consent is required and surfaced to operators.
- **FR-002**: System MUST expose a signed Slack interactivity endpoint that verifies signature + timestamp (same replay window as events), parses the `payload` field, and routes by interactivity type (`block_actions`, `view_submission`, etc.). Unsigned/forged/stale requests MUST be rejected (401) before any side effect.
- **FR-003**: System MUST resolve the acting operator from the Slack user (team_id + slack_user_id) to a Radioso workspace member account via email match, persisting the link for reuse. If no authorized member maps, the action MUST be rejected with an ephemeral Slack reply and no resolution.
- **FR-004**: An approval gate for a Slack-connected workspace MUST deliver an interactive approve/deny (option) message to the configured operator channel, in addition to existing email/webhook delivery; clicking an option MUST resolve the decision through the existing approvals service with the resolving operator recorded.
- **FR-005**: Decision resolution from Slack MUST honor the existing stale-guard (`contentHash`): a stale/duplicate click MUST NOT change the outcome.
- **FR-006**: A gap escalation and a routine handoff for a Slack-connected workspace MUST deliver an interactive take-over / talk-to-customer / hand-back message to the operator channel, in addition to existing delivery.
- **FR-007**: From Slack, an authorized operator MUST be able to take over a conversation (→ `human_owned`, owner recorded, version incremented), hand it back (→ `ai_owned`), via the existing ownership service with optimistic version checks.
- **FR-008**: "Talk to customer" MUST open a Slack modal for reply text; on submit, the reply MUST be persisted as a `human_agent` message (`metadata.humanAgent` = resolving operator).
- **FR-009**: A human-agent reply MUST be delivered to the customer based on the conversation's channel origin: Slack-origin → posted into the customer's original Slack DM/thread via the outbox; web-origin → delivered via the existing web reply path. The system MUST NOT post a customer-facing Slack message for web-origin conversations.
- **FR-010**: After any resolved Slack action, the originating interactive message MUST be updated in place to reflect the outcome/owner; update failure MUST be logged and retried best-effort and MUST NOT block or reverse the resolution.
- **FR-011**: The `slack.post` outbox payload MUST support an interactive (Block Kit) variant in addition to plain text, preserving idempotency and at-least-once delivery; this MUST be covered by the message-queue impact review.
- **FR-012**: Operator-relevant notifications (`approval.request`, `handoff.notify`, gap escalation) MUST fan out through an `OperatorNotificationChannel` seam with email/webhook and Slack-interactive sinks; a workspace without Slack MUST see unchanged email/webhook behavior and no Slack attempt.
- **FR-013**: A Slack-origin conversation MUST persist typed `ConversationChannelContext` (provider, teamId, teamName, channelId, channel type [im/channel], threadTs, slackUserId, slackUserName) at creation, supplied by the Slack connector via the chat `sourceContext`.
- **FR-014**: The history list and detail APIs MUST return the conversation's channel context; the contract change MUST regenerate OpenAPI and sync the TypeScript SDK.
- **FR-015**: The Activity view MUST render a "Slack" badge with channel/thread/user context for Slack conversations and show the same context in the detail drawer, replacing the generic/"authenticated" label; non-Slack conversations are unaffected.
- **FR-016**: All Slack operator actions MUST emit audit events that record the action, conversation, decision/ownership target, and the resolving operator (account + Slack user id/name as provenance), consistent with existing `hitl.*` audit events; no raw content, tokens, or secrets in logs/audit.
- **FR-017**: The system MUST handle the documented edge cases (ambiguous identity, double-action race, message-update failure, customer-delivery failure, reply-before-takeover, Slack-not-connected, replay/forgery) per the Edge Cases section, failing safely.

### Key Entities *(include if feature involves data)*

- **Slack operator identity**: links a Slack user (`team_id` + `slack_user_id`) to a Radioso account within the install's workspace; established lazily by email match; carries Slack display name for provenance.
- **Operator notification**: a domain event ("approval needed" | "handoff/gap" ) routed to one or more delivery sinks (email, webhook, slack-interactive), carrying the resolution handle/version and the action set.
- **Conversation channel context**: typed, provider-discriminated origin metadata stored on the conversation; the Slack variant carries team/channel/thread/user; consumed by Activity and by human-reply delivery routing.
- **Interactive Slack message**: an outbound Block Kit message in the operator channel whose action buttons encode a resolution target (decision handle + contentHash, or conversationId + version) and that is updated in place after resolution.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can approve or deny a pending decision entirely within Slack, with the routine resuming, in under 15 seconds from message to resumed — without opening the dashboard.
- **SC-002**: An operator can take over a Slack-escalated conversation, reply to the customer, and hand back entirely within Slack, with the reply reaching the customer on their original channel.
- **SC-003**: 100% of Slack operator actions resolve through the existing approvals/ownership services (zero duplicated decision/ownership logic in the Slack adapter), and every action is attributed in audit to the real operator.
- **SC-004**: No decision/ownership double-resolves under concurrent dashboard+Slack action (stale clicks rejected, exactly one winner).
- **SC-005**: Every Slack-origin conversation in Activity shows its team/channel/thread/user context; zero Slack conversations display the generic "authenticated chat" label.
- **SC-006**: Workspaces without Slack connected see no change in approval/handoff notification behavior and no Slack errors.
