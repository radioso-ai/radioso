# Feature Specification: Slack Channel (talk to the agent in Slack + escalate to humans)

**Feature Branch**: `092-slack-channel`  
**Created**: 2026-06-18  
**Status**: Approved  
**Input**: User description: "Let customers talk to a Radioso agent from inside Slack, and let the agent escalate to a human Slack channel when curated knowledge does not cover the question. Setup must be zero-token for every Radioso user — install is a one-click 'Add to Slack' OAuth flow, never pasting tokens or signing secrets into the product UI. On Radioso Cloud, Radioso owns the Slack app; self-hosters supply their own app once via a generated manifest + env. Answers come only from curated knowledge — Slack is a front door and an escalation surface, not a knowledge source to dump."

> Design source of truth: `specs/092-slack-channel/research.md` (decisions, rejected alternatives, and path:line evidence from the existing WhatsApp connector, the OAuth substrate, and the skill spine). This spec must stay consistent with it.

## Framing

Two directions, one Slack app, zero user-facing credentials:

1. **Talk *through* Slack (inbound channel).** A customer DMs or @mentions the bot; the agent answers from the workspace's **curated knowledge** with the same grounding discipline as the website widget.
2. **Act *on* Slack (escalation).** When curated knowledge does not cover the question — or a lead/handoff is detected — the agent posts to a configured **human channel** instead of guessing.

Both ride the same Slack connection (one OAuth install → one bot token, stored encrypted, keyed by Slack `team_id`). The reply-into-thread that the channel performs and the escalation post are the *same* `chat.postMessage` call through the *same* Slack Web API client.

**Deliberately out of scope:** reading Slack history as a knowledge source (Slack `search.messages`). It is the only capability that requires a Slack *user* token (extra setup) and it is the one most at odds with Radioso's "curated, not a dump" stance. See Non-Goals.

This feature is **net-new code that mirrors an existing precedent**: the WhatsApp connector (`backend/src/modules/connectors/plugins/whatsapp/`) already implements an inbound conversational channel on the `ConnectorPlugin` substrate. Slack is a second instance of that pattern plus an OAuth install flow and an escalation skill.

## User Scenarios & Testing *(mandatory)*

Stories are sliced so each is an independently shippable MVP increment. Priorities reflect: prove the zero-token install + grounded answer first, then make it safe to deploy (escalation), then make self-host first-class, then widen the inbound surface.

### User Story 1 - One-click install, then a customer gets a grounded answer in a DM (Priority: P1)

A workspace admin connects Slack with a single **"Add to Slack"** click (OAuth consent), picks which agent answers, and is done — no token or signing secret is ever entered into Radioso. A customer then DMs the bot in Slack and receives an answer drawn only from the workspace's curated knowledge; when the knowledge does not cover the question, the agent says so safely rather than fabricating.

**Why this priority**: This is the whole "talk to Radioso through Slack" value end-to-end, with the simplest surface (DMs) and the zero-token install that is the point of the feature. It proves the keystone (OAuth connection + Slack Web API client) and the channel (webhook → turn → reply) in one demoable slice.

**Independent Test**: With a mock Slack (mock OAuth + mock Events API + a stubbed Slack Web API), complete the OAuth install for a workspace, bind an agent, deliver a simulated `message.im` event, and verify: the install stored an encrypted bot token keyed by `team_id`; the inbound event was signature-verified, deduped, and acked within the 3s budget; a conversation was created with `sourceChannel = "slack"`; the agent's grounded answer was posted back to the same DM thread; and no token or signing secret was required in any UI step.

**Acceptance Scenarios**:

1. **Given** a workspace admin on the Slack settings page, **When** they click "Add to Slack" and approve consent, **Then** the connection becomes "connected", the bot token is stored encrypted (never displayed), and the admin is asked which agent should answer.
2. **Given** a connected Slack workspace bound to an agent, **When** a customer sends the bot a direct message, **Then** the agent replies in that DM with an answer grounded in curated knowledge.
3. **Given** a question not covered by curated knowledge, **When** the customer asks it, **Then** the agent declines safely (no fabricated answer) using LLM-generated copy — no hard-coded English string.
4. **Given** a follow-up message from the same customer, **When** it arrives, **Then** it continues the same conversation (prior turns are in context).
5. **Given** an inbound Slack event, **When** it is received, **Then** the system verifies the request signature and rejects unsigned/forged/stale (replay-window) requests, dedupes Slack retries, ignores the bot's own messages (no self-reply loop), and acknowledges within Slack's 3-second window before running the turn asynchronously.
6. **Given** any step of install or use, **When** an admin or customer interacts, **Then** at no point is a bot token, client secret, or signing secret entered into the Radioso UI.

---

### User Story 2 - The agent escalates to a human Slack channel on gaps and leads (Priority: P2)

The agent reaches a human in Slack via **two distinct paths that share one delivery mechanism**:

- **Automatic gap escalation (channel safety policy).** When a turn produces **no grounded answer**, the channel posts to a workspace-configured human channel (e.g. `#support`) so a person can take over instead of the customer hitting a dead end. This fires from a **typed turn outcome** (see FR-016/FR-017) — it is policy enforced by the channel, and it **does not** require the LLM or a routine to elect a Slack action.
- **Routine-authored escalation (lead/handoff).** When an author wants a deliberate hand-off or lead post (e.g. "a qualified lead → `#sales`"), they invoke a `slack` skill from a routine. This is author intent, modeled as a skill (see US-related FR-019).

Both paths post through the **same outbox handler and the same `SlackWebApiClient`**; only the *trigger* differs (channel policy vs. authored routine step).

**Why this priority**: The automatic gap path is what makes the channel safe to deploy customer-facing: "answer what's curated, hand off everything else." It is the "act on Slack" half that completes "both", and it reuses the same bot token and client as US1 — no new credentials. The routine path is additive and uses the existing skill spine.

**Independent Test**: Configure an escalation target channel; drive a turn whose typed outcome is "no grounded answer"; verify an escalation message is enqueued **from that typed outcome (not from parsing assistant text)** and delivered to the target channel via the outbound action path with at-least-once delivery and retry on transient failure, carrying enough context (the question, a conversation reference) for a human to act. Separately, drive a routine that invokes the `slack` skill and verify it reaches the same channel through the same handler — without the gap-policy path being involved.

**Acceptance Scenarios**:

1. **Given** an escalation channel configured for an agent, **When** a turn completes with a typed "no grounded answer" outcome, **Then** the channel posts an escalation referencing the conversation and the customer's question — **driven by the typed outcome, never by inspecting the generated reply text**.
2. **Given** a turn that *did* produce a grounded answer, **When** it completes, **Then** no automatic escalation is posted.
3. **Given** a transient Slack API failure, **When** the escalation is delivered, **Then** it is retried with backoff and not lost (at-least-once), and a permanent failure is recorded for operators without crashing the turn.
4. **Given** the same gap fires twice for one turn, **When** escalations are dispatched, **Then** the customer is not spammed with duplicate posts (idempotent dispatch).
5. **Given** escalation is not configured, **When** a gap occurs, **Then** the agent still degrades safely in the conversation and no delivery is attempted.
6. **Given** a routine that invokes the `slack` skill, **When** the step runs, **Then** the post is delivered through the same outbox handler/client as the gap path, and the gap-policy path is not triggered for that turn.

---

### User Story 3 - Self-hosters connect their own Slack app via a generated manifest (Priority: P3)

A self-host operator turns on the Slack channel for their deployment without hand-assembling a Slack app: Radioso renders a ready-to-paste **Slack app manifest pre-filled with their own public base URL** (scopes, event-subscription URL, OAuth redirect), and tells them exactly which three app secrets to place in env. After that one-time step, every workspace admin gets the identical zero-token "Add to Slack" experience from US1.

**Why this priority**: Makes self-host first-class on the *same* OAuth code path as Cloud (the only difference is who supplies the app's env secrets). It is deployment reach over the proven US1/US2 path, so it follows them; it must not fork the runtime flow.

**Independent Test**: With `APP_BASE_URL` set, render the manifest and assert it contains that base URL in the redirect and event-subscription URLs and the correct scopes; with the three app secrets present in env, assert the OAuth provider registers and "Add to Slack" is enabled; with them absent, assert the feature is cleanly disabled (no crash, clear operator message) and the secrets never appear in logs.

**Acceptance Scenarios**:

1. **Given** a self-host deployment with `APP_BASE_URL` set, **When** the operator opens Slack setup, **Then** Radioso shows a copy-ready app manifest pre-filled with that base URL and a checklist of the env vars to set.
2. **Given** the operator has set the Slack app client id, client secret, and signing secret in env, **When** the backend starts, **Then** the Slack OAuth provider is registered and "Add to Slack" is available to workspace admins.
3. **Given** the Slack app env secrets are not configured, **When** an admin opens Slack settings, **Then** the feature is shown as unavailable with operator guidance, and nothing else breaks.
4. **Given** any deployment, **When** secrets are loaded, **Then** they come only from env (`.env.example` updated) and never appear in logs, traces, or API responses.

---

### User Story 4 - Customers can @mention the bot in shared channels (Priority: P4)

Beyond DMs, a customer or teammate @mentions the bot in a shared Slack channel and the agent replies in-thread, keeping each thread as its own conversation.

**Why this priority**: Widens the inbound surface from 1:1 DMs to shared channels. It is additive to US1 (same install, same turn path) and only needs the `app_mention` event plus in-thread reply/threading rules, so it layers on last.

**Independent Test**: Deliver a simulated `app_mention` event in a channel; verify the agent replies in the originating thread, that the thread maps to a single conversation across multiple mentions, and that non-mention channel chatter is ignored.

**Acceptance Scenarios**:

1. **Given** the bot is in a channel, **When** a user @mentions it, **Then** the agent replies in that message's thread.
2. **Given** an ongoing thread, **When** the bot is mentioned again in the same thread, **Then** it continues the same conversation.
3. **Given** ordinary channel messages that do not mention the bot, **When** they are posted, **Then** the agent does not respond.

---

### Edge Cases

- **App reachability (self-host):** deployment not reachable at a public HTTPS URL → OAuth callback and inbound events cannot arrive; setup must state this requirement and the feature must fail closed with a clear message rather than half-installing.
- **Token revoked / app uninstalled in Slack:** subsequent posts return an auth error → connection is flagged "needs reauth", turns degrade safely, no crash; admin can re-install.
- **Slack retries during a slow turn:** the same event is delivered multiple times → dedupe by Slack `event_id` so only one turn runs.
- **Bot replying to itself / other bots:** events from the bot user or other bots are ignored to prevent loops.
- **Multiple workspaces (Cloud, one shared app):** events arrive at one URL for many `team_id`s → route each event to the workspace+agent that installed for that `team_id`; an event for an unknown/uninstalled team is ignored.
- **Stale request (replay):** request timestamp outside the allowed window → reject.
- **Distributed-app review pending (Cloud):** Slack App Directory review is a Radioso-side prerequisite for public install; until approved, install works only for development/allow-listed workspaces. This gates Cloud rollout, not the code path.
- **Long answers / formatting:** answers exceeding Slack message limits are chunked or truncated gracefully; citations render as links, not raw document/chunk IDs.

## Non-Goals

- **Slack as a knowledge source.** No ingestion of Slack history and no `search.messages`-based grounding. (It needs a Slack user token and contradicts "curated, not a dump".)
- **Human-curated promotion of Slack threads into knowledge** (react-to-save). Noted as a possible future, explicitly not in this feature.
- **Manual credential entry** (bot token / signing secret) anywhere in the product UI. Install is OAuth-only; app secrets are operator env config.
- **Streaming token-by-token replies** into Slack (Slack is not an SSE consumer); replies are delivered as completed messages (a "thinking…" placeholder + update is an optional refinement, not required).
- **Slash commands, interactive components/buttons, Workflow Builder steps** — not in this feature.

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
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Transport/inbound:* a Slack `ConnectorPlugin` mounts the webhook (signature verification, challenge handshake, dedupe, fast-ack) — mirrors `connectors/plugins/whatsapp/`. It owns Slack wire concerns only.
  - *Shared keystone (`slack` module):* owns the **Slack connection/credentials** (OAuth tokens keyed by `team_id`, encrypted) and a **`SlackWebApiClient`** (postMessage, conversations.list, users lookup). Both the channel and the escalation skill depend down on this; neither depends on the other.
  - *Orchestration:* the existing conversation engine runs the turn via the `ConnectorChatPort`/`ChatService.answer(... sourceChannel: "slack")` seam. No turn logic is added to Slack code.
  - *Outbound delivery (one mechanism, two triggers):* a single **Slack outbox handler** posts via the shared `SlackWebApiClient` through the conversation-actions outbox for at-least-once retry. It is fed by two independent triggers that MUST NOT be conflated:
    - **Automatic gap escalation = channel safety policy.** A post-turn policy in the Slack channel enqueues an escalation when the turn's **typed outcome** is "no grounded answer". This path is NOT a skill: it does not pass through skill selection and does not require the LLM/routine to choose a Slack action.
    - **Routine-authored post = `slack` skill kind** on the `agent_skills` spine + an executor implementing the shared `SkillExecutorPort`, for deliberate lead/handoff posts authored in a routine.
    Both enqueue the same outbox action type and resolve to the same handler/client; only the trigger differs.
  - *Auth:* reuse `integrationOauth` provider registry + generic `/oauth/callback/:provider` route; Slack is registered as one provider.
  - *Persistence:* new tables for the Slack installation and channel/agent binding; conversations reuse `conversations.source_channel`.
- **Encapsulation Rule**:
  - The conversation engine, `ChatService`, and routine runner MUST remain unaware of Slack specifics — Slack is `sourceChannel = "slack"` and an executor behind the skill port.
  - The generic OAuth substrate, action outbox, and `ConnectorPlugin` host MUST NOT gain Slack-specific branches; Slack is a registered provider/plugin/handler.
  - The Slack Web API client MUST NOT know about conversations or routines; it speaks Slack HTTP only.
- **New Seams Required**:
  - `slack` module: `SlackInstallation` store (encrypted tokens by `team_id`) + `SlackWebApiClient` + Slack OAuth provider definition + app-manifest generator.
  - Slack `ConnectorPlugin` (inbound webhook + identity→conversation mapping + reply).
  - One **Slack outbox action handler** (posts to a channel via `SlackWebApiClient`) registered on the outbox dispatcher, shared by both triggers.
  - A **typed post-turn outcome signal** the channel can read to detect "no grounded answer" without parsing assistant text. If the `ConnectorChatPort`/turn-result seam does not already surface this as a typed field (the existing grounded-answer flag is the likely source), the plan MUST add a narrow typed outcome on the turn result — never infer the gap from generated copy.
  - A `slack` skill kind + `SlackEscalationExecutor` (routine-authored path only) that enqueues the same action type as the gap policy.
  - A possible small extension to the OAuth substrate: a per-provider **token-response normalizer** (Slack's `oauth.v2.access` returns a non-vanilla `{ok, access_token, team, authed_user, ...}` envelope). This is a general seam, not a Slack hack inside generic code.
- **Anti-Goals**:
  - Do NOT add Slack branches inside the conversation engine, `ChatService`, the generic OAuth service, or the connector host.
  - Do NOT build a second Slack integration: the channel reply and the escalation post MUST share one `SlackWebApiClient` and one credential store.
  - Do NOT introduce any manual-token code path "for now"; OAuth install is the only path.
  - Do NOT add Slack `search.messages` / history ingestion (Non-Goal).
  - Do NOT encode routing/intent/escalation triggers with English keyword lists, and do NOT detect "no grounded answer" by inspecting the generated reply text; the gap trigger MUST come from a typed turn outcome (the grounded-answer signal), and routine posts from authored skill steps.
  - Do NOT make automatic gap escalation depend on the LLM/routine electing a Slack skill; gap escalation is channel policy driven by a typed outcome, separate from skill selection.

## Requirements *(mandatory)*

### Functional Requirements

**Install & credentials (zero-token)**
- **FR-001**: A workspace admin MUST be able to connect Slack via a one-click "Add to Slack" OAuth consent flow; the product UI MUST NOT accept manual entry of bot tokens, client secrets, or signing secrets.
- **FR-002**: On successful install, the system MUST store the issued Slack bot token encrypted at rest (reusing the connector encryption key), keyed by Slack `team_id`, and MUST never display or return it.
- **FR-003**: The system MUST map a Slack installation (`team_id`) to a Radioso workspace and a selected answering agent, and the admin MUST be able to choose/change that agent.
- **FR-004**: Slack app-level secrets (client id, client secret, signing secret) MUST be supplied via env only; `.env.example` MUST document them. On Cloud these are Radioso's; self-host operators supply their own.
- **FR-005**: When app-level secrets are absent, the Slack feature MUST be cleanly unavailable (no crash) with operator guidance, and "Add to Slack" MUST be hidden/disabled.

**Inbound channel**
- **FR-006**: The system MUST expose a single Slack events webhook that handles Slack's `url_verification` challenge and accepts events for any installed `team_id` (multi-tenant by `team_id`).
- **FR-007**: The webhook MUST verify each request's Slack signature using the signing secret and the timestamp, MUST reject requests outside the allowed replay window, and MUST reject forged/unsigned requests.
- **FR-008**: The webhook MUST deduplicate Slack retries by event id (process each event's turn at most once) and MUST acknowledge within Slack's 3-second window, running the turn asynchronously.
- **FR-009**: The system MUST ignore events originating from the bot itself or other bots to prevent reply loops.
- **FR-010**: For a `message.im` (DM) event, the system MUST create or resume a conversation bound to the mapped agent with `source_channel = "slack"`, run one turn, and post the agent's answer back to the originating DM.
- **FR-011**: Successive messages from the same Slack user/thread MUST continue the same conversation (multi-turn context).
- **FR-012** *(US4)*: For an `app_mention` event, the system MUST reply in the originating thread and treat each thread as its own conversation; non-mention channel messages MUST be ignored.

**Curated answering**
- **FR-013**: Answers delivered to Slack MUST come only from the workspace's curated knowledge with the same grounding discipline as other channels; the agent MUST NOT fabricate answers.
- **FR-014**: When curated knowledge does not cover a question, the agent MUST decline safely using LLM-generated copy (no hard-coded conversational strings).
- **FR-015**: Citations rendered into Slack MUST be link-only and MUST NOT expose internal document/chunk IDs.

**Escalation (act on Slack)**
- **FR-016**: An admin MUST be able to configure a human Slack channel as an escalation target for an agent. The turn MUST expose a **typed "no grounded answer" outcome** (the grounded-answer signal as a structured field on the turn/connector result), and the gap-escalation trigger MUST read only that typed outcome — it MUST NOT detect the gap by parsing the generated reply text.
- **FR-017 (automatic gap escalation — channel policy)**: When a turn's typed outcome is "no grounded answer", the channel MUST enqueue an escalation post to the configured target channel (the customer's question + a conversation reference) **as channel policy** — without the LLM or a routine electing a Slack skill, and without passing through skill selection. If no escalation channel is configured, the turn MUST still degrade safely and no post is attempted.
- **FR-018**: Escalation delivery MUST be at-least-once with retry/backoff on transient failure and idempotent per triggering turn (no duplicate spam); permanent failures MUST be recorded for operators without failing the customer's turn.
- **FR-019 (routine-authored escalation — skill)**: An author MUST be able to post to a Slack channel from a routine via a `slack` skill (deliberate lead/handoff). This path is author intent through the skill spine; it MUST enqueue the **same outbox action type** and resolve to the **same handler and `SlackWebApiClient`** as the automatic gap path (FR-017). The two paths share delivery; they MUST NOT share triggering (gap = typed outcome; routine = authored step).
- **FR-020**: All Slack outbound posts — the inbound channel reply (FR-010/FR-012), automatic gap escalation (FR-017), and routine-authored posts (FR-019) — MUST use the same `SlackWebApiClient` and the same stored credential.

**Self-host setup**
- **FR-021**: Radioso MUST render a copy-ready Slack app manifest pre-filled with the deployment's `APP_BASE_URL` (correct scopes, event-subscription URL, and OAuth redirect URI) plus the list of env vars to set.

**Observability & safety**
- **FR-022**: The system MUST emit logs/metrics/traces for install, inbound receipt, turn dispatch, and outbound delivery using identities and counts only — never message text, tokens, secrets, or retrieved content.
- **FR-023**: If a stored token is revoked or the app is uninstalled, the connection MUST be flagged "needs reauth", turns MUST degrade safely, and re-install MUST restore service.
- **FR-024**: Product-surface documentation (setup for Cloud and self-host, what data flows, the curated-only / no-history-ingestion stance) MUST be added/updated in the same change.

### Key Entities *(include if feature involves data)*

- **Slack Installation**: a connected Slack workspace. Keyed by `team_id`; holds the encrypted bot token, granted scopes, status (connected / needs-reauth / disabled), and the owning Radioso workspace. One per Slack team per Radioso workspace.
- **Slack Channel Binding**: the routing config for an installation — which agent answers inbound messages and which human channel receives escalations.
- **Conversation (extended)**: existing conversation record with `source_channel = "slack"` and a stable mapping from the Slack identity tuple (`team_id`, and DM user or channel `thread_ts`) to the conversation.
- **Slack Outbox Action**: the single outbound post unit (target channel + message + conversation reference) enqueued on the conversation-actions outbox and delivered by one shared handler via `SlackWebApiClient`. Enqueued by both the gap policy and the routine skill.
- **Typed Turn Outcome (grounded-answer signal)**: a structured field on the turn/connector result indicating whether the turn produced a grounded answer. The gap-escalation policy reads this; it is never derived from reply text.
- **Slack Escalation Skill (routine path only)**: a `slack`-kind entry on the agent-skills spine whose executor enqueues a Slack Outbox Action for deliberate, author-triggered lead/handoff posts.
- **Inbound Event Log**: dedupe/idempotency record keyed by Slack `event_id` (and retry metadata) to ensure at-most-once turn processing.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workspace admin can go from "not connected" to "a customer can DM the agent" in under 2 minutes on Cloud, entering **zero** tokens or secrets.
- **SC-002**: Across the entire user-facing flow (admin + customer), the number of credentials manually entered into the Radioso UI is **0**.
- **SC-003**: 100% of inbound Slack events are acknowledged within Slack's 3-second window; Slack does not mark the endpoint as failing under normal load.
- **SC-004**: 100% of accepted inbound events result in at most one agent turn (no duplicate replies from retries; no self-reply loops) in dedupe/loop tests.
- **SC-005**: For questions outside curated knowledge, the agent declines or escalates in 100% of cases and fabricates an answer in 0% (measured on an eval set).
- **SC-006**: Configured escalations reach the target channel with at-least-once delivery; transient-failure injection shows retry-to-success and no lost or duplicated escalations.
- **SC-007**: A self-host operator can enable Slack using only the generated manifest + env vars (no hand-built app config), verified by a setup walkthrough.
- **SC-008**: No token, signing secret, or message content appears in logs, traces, or API responses (verified by inspection/tests).
- **SC-009**: Automatic gap escalation is triggered by the typed turn outcome with 0 occurrences of text-based gap detection (verified by tests asserting the trigger reads the typed field, not reply text), and the routine path posts through the same handler/client (verified by a shared-handler test).
