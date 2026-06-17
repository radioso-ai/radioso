# Feature Specification: Human-in-the-Loop Controls (approvals, takeover, and hand-back)

**Feature Branch**: `091-human-in-the-loop-approvals`
**Created**: 2026-06-17
**Status**: Draft (revision 2 — review fixes 1–5 applied: reserved silent source value, US4/US5 independence, side-effect-only vs message-emitting resume rule, event-stream backing design named, suppression across all entry points)
**Input**: User description: "Start thinking about HITL. Research how others do it, deliver a strong detailed suggestion, then write a spec." Design direction and full research in `.context/hitl-design-memo.md` (+ `hitl-research-synthesis.md`, `hitl-design-raw.json`). Amendment decisions: takeover is full human ownership with explicit hand-back; v1 delivery is cursor polling, not websockets; takeover stays in this 091 HITL spec as later user stories; human-authored chat messages are visible and named.

> **Scope of this spec is the broader HITL product shape, sequenced by user story.**
> User Stories 1-3 are the approval MVP: the durable suspend/resume primitive, an
> operator approval queue, and message attribution. Later stories extend the same
> ownership and attribution model to human takeover, where a human operator becomes
> the sole responder until they explicitly hand the conversation back to the AI.
> Per-skill auto-gating + autonomy dial, end-user in-chat approval cards, automated
> timeout/SLA handling, agent-assist drafting, true push delivery (SSE/websockets),
> and silent "on behalf of the agent" human replies remain out of scope.

> **Terminology.** A **decision** is something a human must resolve before a paused
> routine continues (here: approve / reject). It is distinct from a Radioso
> **action** (a fire-and-forget side effect on the conversation-actions outbox) and
> from a **clarification** (asking the *end user* to pick among comparable
> candidates). HITL generalizes the clarification *shape* (ask → persist → resume)
> to a **non-user decider** and a **richer decision payload**. A **takeover** is a
> conversation ownership state: while active, a named human operator owns the
> conversation, the AI agent is suppressed, and only an explicit hand-back restores
> AI responses.

## Problem

Radioso's routines can take consequential actions (send an email, call an external
MCP skill, hit a webhook), but there is no way to require a human to approve before
the side effect happens. There is also no first-class way for a human operator to
take over a conversation without racing the AI or hiding who is speaking. The
platform has every structural ingredient of human-in-the-loop **except the one that
matters**: durable ownership states that can be changed by *something other than the
visitor's next message*. The conversation contracts even reserve the vocabulary for
it (`SkillOutcomeStatus.paused` / `awaiting_confirmation` / `awaiting_tool`,
`SkillDispatchResult.deferred`, the `handoff` routine terminal,
`SkillOutcomeControl.sessionMode: "manual"`) — all dormant and unwired. Today every
durable pause (clarification, routine slot-filling) resumes only on an inbound
**user** turn, every side effect (the outbox) is fire-and-forget with no result
channel back into the conversation, and manual operator replies have no durable
"AI is silent until hand-back" state.

The fix is a small set of capability-neutral HITL primitives: **a routine step can
suspend until an authorized human resolves a decision, and the routine resumes from
exactly that step on the decision**; **a conversation can enter manual ownership, in
which a named human is the sole responder until explicit hand-back**; and **both
visitors and operators can discover new conversation events through a cursor-based
polling stream**. The approval MVP proves the architecture on the simplest gate; the
later takeover stories reuse the same source, ownership, event, and audit model
instead of inventing a parallel handoff system.

## Release Sequencing

- **Tranche A — approval MVP**: User Stories 1-3 and Functional Requirements
  FR-001 through FR-016. This is the first implementation target.
- **Tranche B — takeover and hand-back**: User Stories 4-5 and Functional
  Requirements FR-017 through FR-024. These stories are in this spec so the approval
  schema, attribution, event, and audit choices are compatible with takeover, but
  they do not have to ship in the same implementation slice as Tranche A.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A gated routine action waits for human approval and resumes on the decision (Priority: P1)

A routine author adds an **approval step** before a consequential action step (e.g.
before "@issue_refund"). When a conversation reaches that step, the routine
**suspends**: the visitor sees a brief, LLM-authored "this needs review" reply, and
nothing downstream runs. An authorized workspace member opens the conversation,
sees the proposed action, and **approves** or **rejects** it. On approval the routine
resumes at the gated step and the action fires exactly as if it had been reached
directly; on rejection the routine follows its authored rejection path and the action
never runs.

**Why this priority**: This is the keystone and the minimum viable HITL value — it
forces the durable suspend/resume primitive, the pending-decision store, the
non-user resume entry point, and the authenticated decision endpoint into existence.
Without it nothing else in HITL is possible; with it, an operator can already gate
real side effects.

**Independent Test**: Publish a routine with an approval step before an action step.
Drive a conversation to the gate — assert the action has **not** fired, the routine
state is suspended, and a pending decision exists. Approve via the decision endpoint
— assert the routine resumed at the gated step, the action fired exactly once, and
the conversation continued. Repeat with a reject — assert the action never fired and
the routine took its rejection path.

**Acceptance Scenarios**:

1. **Given** a published routine whose graph contains an approval step before an
   action step, **When** a conversation reaches the approval step, **Then** the
   routine suspends (state recorded as suspended, excluded from the normal user-turn
   resume path), the downstream action does **not** execute, and the turn renders a
   short LLM-authored "awaiting review" reply.
2. **Given** a suspended routine with a pending decision, **When** an authorized
   member approves it, **Then** the routine resumes **at the gated step** (no prior
   step is re-run), the gated action executes exactly once, and the conversation
   continues normally.
3. **Given** a suspended routine with a pending decision, **When** an authorized
   member rejects it, **Then** the routine follows its authored rejection edge, the
   gated action never executes, and the conversation continues normally.
4. **Given** a pending decision, **When** the same decision is submitted twice
   (double-click, redelivery, two operators), **Then** the decision is applied
   exactly once and the second submission is rejected as already-resolved — the
   gated action never fires twice.
5. **Given** a decision was recorded but the process crashes before the resumed turn
   is persisted, **When** the resume is retried, **Then** the human is **not**
   re-prompted and the routine resumes idempotently (the decision is durable; resume
   is safe to replay).
6. **Given** a suspended routine, **When** the visitor sends another message before a
   decision is made, **Then** the conversation answers that message normally (the
   suspended routine does not capture the turn and is not advanced), and no new
   routine activates over the suspended one.
7. **Given** a decision submitted by a member who is **not** authorized to decide for
   this agent, **When** the endpoint is called, **Then** it is rejected
   (authorization is enforced server-side, independent of any UI affordance) and the
   routine stays suspended.

---

### User Story 2 - Operators triage pending approvals from a queue and are notified out-of-band (Priority: P2)

An operator should not have to babysit a chat window. When a decision is created, an
out-of-band notification (reusing the existing contact-delivery transport) tells the
configured recipient that an action needs review and links to it. In the dashboard,
pending approvals appear in a **queue** with enough context to decide in seconds: what
the agent wants to do, why it was gated, the recent conversation, and the deadline.
Approving or rejecting from the queue drives the same authenticated decision path as
User Story 1.

**Why this priority**: User Story 1 makes the loop *possible*; this makes it
*operable* at human scale. It turns "approve via an API call" into a real review
experience and ensures decisions are not silently stranded.

**Independent Test**: With the US1 primitive in place, create a pending decision and
assert a notification is dispatched through the delivery transport carrying a link to
the decision. Open the dashboard queue — assert the pending decision is listed with
its proposed-action summary, gate reason, deadline, and a link to the conversation.
Approve from the queue — assert it routes through the same endpoint and the row
leaves the pending list.

**Acceptance Scenarios**:

1. **Given** a new pending decision, **When** it is created, **Then** a notification
   is dispatched out-of-band to the agent's configured recipient(s), carrying a
   single-use link to the decision — and the notification path never blocks the turn.
2. **Given** pending decisions in a workspace, **When** an operator opens the
   approval queue, **Then** each pending decision shows the proposed action (from
   structured metadata, not a classified string), the gate **reason** (never a raw
   confidence number), the conversation it belongs to, and a deadline; overdue items
   are visually distinguished.
3. **Given** the approval queue, **When** an authorized operator approves or rejects a
   row, **Then** the decision is applied through the authenticated endpoint and the
   row optimistically leaves the pending list (reverting on failure).
4. **Given** an operator who is not an authorized decider, **When** they view the
   queue, **Then** they can read the pending decisions but the approve/reject
   controls are unavailable (and the server rejects any decision they attempt).
5. **Given** a decision is resolved by one operator, **When** another operator views
   the queue shortly after, **Then** the resolved row is no longer actionable (no
   double-handling).

---

### User Story 3 - Every message records who produced it (Priority: P3)

Every persisted message records **who produced it** — the visitor, the AI agent, the
platform, or a human operator. Human-authored messages are visible as human-authored
messages and include the human's display name in the chat response presentation. No
behavior changes for existing conversations; this is a non-breaking schema and
rendering addition.

**Why this priority**: It is the cheapest thing to add now and the most painful to
retrofit later — takeover and any future agent-assist surface are *rendering and
ownership* decisions that depend on a per-message source discriminator. Carrying the
human source vocabulary now means the takeover phase needs no message-schema
migration. It delivers immediate value as read-only attribution in the operator's
conversation view while explicitly avoiding silent "on behalf of the AI" replies.

**Independent Test**: Send a normal conversation. Assert each persisted message
carries a source (`customer` for the visitor, `ai_agent` for the assistant,
`system` for platform notices), defaulted from the existing role for pre-existing
rows. Open the conversation in the dashboard — assert the source is rendered.

**Acceptance Scenarios**:

1. **Given** the message persistence path, **When** any message is written, **Then**
   it records a `source` value, and existing rows read back with a `source` derived
   from their role (no migration of historical content required).
2. **Given** a conversation, **When** an operator opens it in the dashboard, **Then**
   each message's source is visible.
3. **Given** the message contract, **When** it is exposed over the public API / SDK /
   MCP, **Then** the `source` field is additive and optional — no existing consumer
   breaks.
4. **Given** a future human-authored response, **When** it is rendered in chat,
   **Then** it is visibly attributed to the human operator by display name and is not
   presented as an AI-authored message.

---

### User Story 4 - A human operator takes over and the AI goes silent until hand-back (Priority: P4)

An authorized operator takes ownership of a live conversation from the dashboard.
While takeover is active, visitor messages do **not** trigger AI answers, routines,
retrieval, or skill dispatch. The operator replies as themselves with their display
name visible in the conversation. When the operator explicitly hands the conversation
back, subsequent visitor messages return to the normal AI path.

**Why this priority**: This is the clean human-interjection model. It avoids two
responders racing in the same thread, preserves visitor trust by making the human
identity visible, and gives operators a deterministic emergency brake for sensitive
or high-risk conversations.

**Independent Test**: Start a conversation, take it over as an operator, then send a
visitor message. Assert no AI turn starts and the conversation state is manual. Send
a human reply and assert it is persisted as `human_agent` with the operator display
name. Hand back to AI, send another visitor message, and assert the ordinary AI
turn path resumes.

**Acceptance Scenarios**:

1. **Given** an active conversation, **When** an authorized operator takes over,
   **Then** the conversation enters manual ownership with the operator identity,
   takeover timestamp, and audit event recorded.
2. **Given** a conversation in manual ownership, **When** the visitor sends a message,
   **Then** no AI response, routine activation, retrieval answer, skill call, or
   action dispatch is started for that visitor message.
3. **Given** a conversation in manual ownership, **When** the owning operator sends a
   reply, **Then** the message is persisted with `source: human_agent`, the operator
   id, and the operator display name, and is visible to operators viewing the
   conversation. (Visitor-facing delivery and rendering of this human reply is covered
   by User Story 5, which owns the visitor receive path.)
4. **Given** a conversation in manual ownership, **When** a different operator tries
   to reply or hand back without permission, **Then** the server rejects the action or
   requires an explicit ownership transfer according to workspace permission policy.
5. **Given** a conversation in manual ownership, **When** the operator explicitly
   hands it back to the AI, **Then** manual ownership ends, an audit event is
   recorded, and the next visitor message follows the normal AI path.
6. **Given** a conversation in manual ownership, **When** background approval
   decisions are resolved, **Then** a side-effect-only resume (the gated action fires
   with no AI utterance) may proceed if the host marks it safe, while a
   message-emitting resume is parked until hand-back; in no case is an AI-authored
   message emitted into the manually owned conversation.

---

### User Story 5 - Visitors and operators discover takeover events by polling a cursor stream (Priority: P5)

The chat surfaces and dashboard do not need websockets for the first takeover cut.
They poll a conversation event stream with a cursor. The dashboard history list and
the visitor's session-bound conversation read already exist, but the visitor read is a
full-detail GET with no incremental polling today — so this story adds cursor/delta
event semantics and introduces visitor polling for the first time (it does not merely
reuse an existing poll). Poll results include new visitor messages, AI messages, human
messages, ownership changes, and hand-back events. The transport is specified so a
later SSE/websocket implementation can carry the same event envelope without changing
conversation semantics.

**Why this priority**: Takeover is only usable if both sides see state changes
promptly, but true push is the wrong first dependency. Cursor polling keeps the
runtime compatible with existing history reads and leaves room for push transport
later.

**Independent Test**: Poll a conversation event stream from both visitor and
operator clients. Create a takeover, send a human reply, and hand back. Assert each
client can advance its cursor and receives the ordered ownership and message events
without duplicate rendering after repeated polls.

**Acceptance Scenarios**:

1. **Given** a client has a conversation event cursor, **When** it polls after new
   messages or ownership changes, **Then** it receives all events after the cursor in
   stable order and a next cursor for the following poll.
2. **Given** a visitor client is polling during manual ownership, **When** a human
   operator replies, **Then** the visitor receives a human message event with the
   operator display name and no hidden AI impersonation metadata.
3. **Given** an operator client is polling, **When** the visitor sends a message
   during takeover, **Then** the operator sees the visitor message and the current
   manual ownership state; no AI-generated response event appears.
4. **Given** a client repeats a poll with the same cursor after a retry, **When** the
   stream returns already-seen events, **Then** event ids allow the client to render
   idempotently.
5. **Given** a later transport wants true push, **When** SSE or websockets are added,
   **Then** they MUST reuse the same event envelope and ordering semantics rather
   than creating a second realtime contract.

---

### Edge Cases

- **Decision against a stale proposal**: if the proposed action's content changed
  since the decision was presented, the decision is rejected (a content hash binds
  the decision to the exact proposal). The gated action never ships under a mismatched
  approval.
- **Unknown / already-resolved / expired handle**: resolving a handle that does not
  exist, is already decided, or has been cancelled is a safe no-op that returns a
  clear conflict status; nothing resumes.
- **Suspended routine is abandoned**: the conversation goes idle for a long time.
  The suspended routine MUST NOT be silently dropped by the existing 30-minute
  routine-state abandon clock (its abandon clock is paused while suspended). Automated
  deadline handling (auto-reject / escalate) is a future phase; in this cut an overdue
  decision simply shows as overdue in the queue and remains resolvable.
- **Second gate in the same conversation**: a routine that needs two approvals
  authors two sequential approval steps; each is its own pending decision. (Two
  *concurrent* in-flight routines per conversation remain disallowed, preserving the
  existing "at most one in-flight routine per session" invariant.)
- **Resume lands wrong**: a resume that would re-enter a satisfied slot step and
  fast-forward repeatedly MUST be prevented — resume starts traversal on the gate
  step and advances forward only (no back-edge into a filled step; see
  `project_routine_runtime_quirks`).
- **Suspended turn is not an answer**: the suspended turn must not be recorded as a
  completed assistant answer (no answer-billing, distinct audit/outcome).
- **Public/embed surface**: the resume handle is never the conversation id (which is
  visitor-visible); it is an unguessable single-use secret. The operator path is
  dashboard-authenticated; this cut does not expose an end-user in-chat decision
  affordance.
- **Concurrent takeover attempts**: if two operators attempt takeover at the same
  time, the ownership change is compare-and-set. Exactly one operator becomes owner;
  the loser sees the current owner and must explicitly request/perform transfer if
  policy allows.
- **Takeover while a routine is active**: entering manual ownership must define what
  happens to an active non-suspended routine. The safe default is to park/block
  routine advancement under manual ownership rather than letting the AI continue
  through the routine while the human is responding.
- **Hand-back with unread visitor messages**: hand-back does not retroactively feed
  every visitor message received during manual ownership into the AI as new turns.
  The next visitor message after hand-back starts the AI path unless the operator
  explicitly asks for an AI summary/draft in a future agent-assist phase.
- **Operator identity changes**: if the owning operator is deactivated or loses
  permission while holding a conversation, supervisor hand-back/transfer remains
  available through server-side authorization and audit.

## Capability Contracts *(mandatory for this feature)*

These contracts are the composability spine. Planning may refine naming and
placement but MUST NOT weaken the responsibility split. The governing rule: **the
conversation engine learns only "a step awaits external resolution of handle X with
options of type T"; it never learns who decides, the transport, or the policy.**

### Engine ↔ host responsibility split

- **Engine (conversation-contract + conversation-engine packages, product-agnostic)**
  owns: the `await` runtime step kind; producing an `awaitingDecision` result that
  carries an opaque, host-minted `handle`, the gated `stepId`, the offered options,
  and the variable key the decision is captured under; and a **resume entry point**
  that, given a decision, loads the suspended state, validates the chosen option,
  captures it as a variable, and continues the routine **from the gated step**. The
  engine treats option payloads as opaque and never interprets them, never performs
  notification, HTTP, authorization, or policy.
- **Host (backend)** owns: minting the handle; the durable pending-decision store;
  committing the suspension atomically with routine state; the authenticated,
  validated decision endpoint; dispatching the notification; recording audit; and the
  operator surface. The host hands the engine an **already-validated** decision (open,
  authorized, hash-matched).
- This mirrors the clarification ownership split (engine owns the generic resolve;
  backend owns stores, endpoint, wiring) deliberately — but the resume **mechanism**
  is net-new (an operator decision is not a `TurnContext`/user message and MUST NOT
  be routed through one).

### The approval (`await`) step and decision capture

- **Author vocabulary**: a new `approval` authoring step kind compiles to a runtime
  `await` step. The approval step is authored, never model-chosen (same safety
  rationale as `actionType`/`toolRef`): an emitted decision cannot be redirected by
  user or payload text.
- **Gate placement**: the `await` step is compiled to sit **before** the
  side-effecting step it gates. When suspended, the side effect has **not** run;
  resume advances from the `await` step **into** the gated step (running it for the
  first time, post-approval). The skill dispatcher is **not** the suspension point in
  this cut.
- **Decision is a captured variable**: the resolved option (its id + optional opaque
  payload) is merged into routine variables under the step's authored capture key.
  The `await` step's outgoing edges are gated by the **existing** deterministic
  guards (`field` on the captured key, `slot_filled`, `default`) — no new guard kind,
  no LLM round-trip, no English keyword matching. Authoring MUST require exactly one
  deterministic outgoing edge per decision outcome (approve / reject) plus a
  fallback, so resume branches in code.

### Pending-decision store and atomic commit

- A **new, narrow store** for pending decisions — a **sibling** of the
  conversation-actions outbox, **not** a status flag on routine state and **not** a
  column added to the outbox. Rationale (what-each-module-knows): a *decision* knows
  who may decide, the option set, the chosen option, decider identity, a content
  hash, and a deadline; a *dispatch* (outbox) knows none of these. Conflating them
  would also collide the outbox's content-addressed idempotency key across re-asked
  approvals of the same proposal.
- The store holds, per pending decision: the opaque `handle`, the conversation /
  workspace / agent scope, the gated routine + step reference, the offered options,
  the **decider scope** (who may resolve, resolved server-side), a **content hash**
  binding the decision to the exact proposal, a **deadline**, and the decision
  lifecycle (`pending → approved | rejected | cancelled`; `timed_out` / `escalated`
  reserved for the future timeout phase).
- **One open decision per gate** is enforced at the database (a unique partial index
  on conversation + routine + step where status is pending).
- **Atomic commit**: the suspended routine state and the pending-decision row commit
  in the **same transaction** as the assistant turn (extending the existing
  command-capture / deferred-commit fence used for routine state and the outbox). A
  routine never reaches "suspended" without a decision row, and never has a decision
  row without being suspended. A crash before commit leaves the routine un-advanced
  (it re-renders the gate), never half-suspended.

### Suspended routine state

- Routine state gains a **`suspended`** status. The existing "load active routine for
  this session" read MUST continue to return only `active` rows, so a suspended
  routine is invisible to the normal user-turn resume path (this is what makes the
  pause durable against an inbound user message). A new read loads a suspended routine
  **by handle** (not by session), so an external decision resumes the exact parked
  instance.
- While suspended, the routine state's existing abandon/expiry clock MUST be paused
  (so the 30-minute abandon sweep cannot silently drop a routine waiting on a human).
- Concurrent writers (a user turn falling through + an operator resume) MUST NOT
  clobber each other: the routine-state save on resume is guarded by an expected
  version (optimistic concurrency), and a losing resume is reported as a conflict for
  retry rather than overwriting.

### Validated decision endpoint

- A new **authenticated** operator endpoint resolves a decision by handle. It is a
  **validated submission** (decide at submit time, not fire-and-forget): in order, it
  checks the handle exists and is open; the caller is an authenticated workspace
  member; the caller satisfies the decision's **decider scope** (server-side, never
  trusting a UI affordance); the submitted content hash matches; and the option is
  valid. Resolution is a **compare-and-set** so exactly one submission wins; a
  redelivered or concurrent second submission is a no-op conflict.
- On success, in one transaction, it records the decision (idempotently) and an audit
  event, then drives the engine resume and persists the resumed turn through the
  normal turn-commit path.
- The handle is an **unguessable, single-use** secret, **never** the conversation id.
  Authorization is the operator's authenticated session; the handle is the
  correlation key. This cut does not expose an end-user (public/embed) decision path.

### Suspended-turn outcome

- A suspended turn is a **distinct outcome**, not a completed answer: it MUST NOT be
  recorded as a successful assistant answer, MUST NOT be billed as an answered turn,
  and MUST carry a distinct audit signal. The resumed turn (which produces the actual
  answer) is the billable/answered turn.

### Message source discriminator

- A per-message **`source`** discriminator, orthogonal to the existing chat `role`:
  `customer | ai_agent | human_agent | human_agent_on_behalf_of_ai_agent | system`.
  The `human_agent_on_behalf_of_ai_agent` value is **reserved and unused in this
  spec** — no code path emits it (human replies here are always visible and named via
  `human_agent`). It is carried in the type vocabulary now, and `source` is stored as
  an **unconstrained `TEXT` column** (not a DB enum/CHECK), so the future silent
  "on behalf of the AI" phase needs neither a migration nor a contract change — the
  retrofit insurance US3 is buying. Human-authored messages also carry the operator id
  and display name needed to render a visible named human response. The engine never
  branches on `source`; it is descriptive metadata for persistence and rendering.
  Existing rows derive `source` from `role` on read; the field is additive/optional on
  all public surfaces.

### Conversation ownership and takeover suppression

- Conversation ownership is a host-owned state machine with at least
  `ai_owned | human_owned`. `human_owned` records the owning operator, takeover time,
  optional reason, and version. It is a conversation-level control, not a message
  role, not a routine status, and not a model instruction.
- While ownership is `human_owned`, the inbound visitor-message path MUST short-
  circuit before AI turn creation: no routine activation/resume from visitor input,
  no retrieval answer, no model call, no skill dispatch, and no conversation-action
  outbox writes caused by that visitor message. The visitor message is still
  persisted and made visible to the operator.
- Only explicit hand-back changes ownership from `human_owned` to `ai_owned`.
  Time-based automatic hand-back is out of scope for this spec. Ownership transfer
  between operators, if allowed, is a server-authorized action with audit.
- Human replies are first-class messages on the conversation. They are visible to
  the visitor as human-authored, include the operator display name in the response
  presentation, and append audit metadata without exposing private operator-only
  notes.
- Approval decisions and takeover overlap through an explicit compatibility rule that
  distinguishes **two resume flavors**, because they are not equally safe under manual
  ownership:
  - A **message-emitting resume** (the routine would render an AI-authored reply to
    the visitor) MUST NOT proceed while the conversation is `human_owned` — the AI must
    never speak into a human-owned conversation. It is deferred until hand-back (the
    decision stays recorded; the resume is parked, not lost).
  - A **side-effect-only resume** (the routine performs its gated non-conversational
    action — e.g. issuing the refund — and emits no AI chat message) MAY proceed under
    `human_owned` only when the host marks that resume as side-effect-only/safe;
    otherwise it too defers to hand-back.
  Planning MUST define how a resume is classified (side-effect-only vs
  message-emitting); the safe default is to treat any resume that could utter to the
  visitor as message-emitting and defer it.

### Cursor-polled conversation event stream

- First-cut realtime is **poll-first**: visitor and operator clients poll a
  conversation event stream with a cursor. No websockets or SSE are required in this
  spec. **Note on reuse (verified):** the dashboard already has a cursor-paginated
  history list, and the visitor already has a session-bound conversation read
  (`GET /api/v1/public/chat/:token/history/:conversationId`, gated by
  `public_chat.history.read.own`) — but that visitor endpoint is a full-detail GET and
  there is no visitor message-polling today (visitors receive content only as the
  streamed response to their own send). So this story **adds** incremental cursor/delta
  semantics and **introduces visitor polling for the first time**; it does not merely
  reuse an existing poll.
- **Backing store (design decision for planning):** message, decision, and ownership
  events live in three different tables, so a single **stable global order** across
  them cannot come from any one table's cursor. Planning MUST choose between (a) a new
  append-only `conversation_events` table (or a shared monotonic sequence) that all
  three writers append to, and (b) an ordered union view with a deterministic
  tiebreak. The cursor's stability and idempotency depend on this choice; (a) is
  recommended.
- The event envelope is transport-neutral and includes ordered event id, cursor,
  conversation id, created-at, event type, actor/source metadata, and an event body.
  Initial event types include message-created, decision-created/resolved,
  ownership-taken, ownership-transferred, and ownership-handed-back.
- Polling MUST be idempotent. Repeated polls with the same cursor may return the same
  event ids, and clients deduplicate by event id. Ordering semantics are defined here
  so a later SSE/websocket transport can stream the same envelope without changing
  contracts.

### Notification transport

- The pending-decision notification reuses the existing conversation-actions outbox
  **only as transport** (a new action type with a handler registered the same way the
  contact-send handler is), delivering through the existing per-agent contact
  delivery resolver. The outbox stays fire-and-forget; the **decision** lives in the
  pending-decision store. Re-notifying an unresolved decision reuses the same
  decision row and emits a fresh, de-duplicated transport nudge.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- The "awaiting review" reply shown to the visitor and any decision-related
  conversational copy are user-facing and MUST be produced by the LLM (multilingual);
  they MUST NOT be hard-coded application strings.
- The decision option set, gate reason, and decision outcomes MUST be structured
  metadata or enums — never English keyword lists, verb lists, or language-specific
  regexes (Radioso is multilingual). The proposed-action summary in the queue is
  rendered from structured metadata, not a classified string.
- New runtime prompt assets (if any) MUST live under `backend/prompts/`.
- Backend development MUST follow TDD: tests written and failing before
  implementation. The durable suspend→resume loop is the integration-test deliverable
  of User Story 1.
- Frontend user-visible behavior (the approval queue journey, source rendering,
  takeover controls, human reply rendering, and cursor polling) MUST prefer
  Playwright coverage; frontend unit tests MUST stay focused on non-visual logic
  (data transforms, queue/event mappers), not markup or design tokens.
- Secrets and keys MUST live in `.env`; `.env.example` updated if new configuration is
  introduced (the resume-handle secret derivation, if any, follows the existing
  workspace-token-secret pattern).
- Customer data MUST be protected with least-privilege access: the decision endpoint
  enforces decider scope server-side; the resume handle is unguessable and single-use;
  observability records step ids, the gate reason, the chosen option id, decider
  identity, and the content hash — **never** raw prompts, completions, retrieved
  chunks, document content, captured slot values, credentials, or connection strings.
- Admin-facing pages MUST use the shared dark theme and existing design tokens; the
  approval queue extends the existing Quality view's badge/triage patterns rather than
  introducing new conventions.
- **Message-queue / contract review**: this feature adds a new outbox action **type**
  (the decision notification) — the plan MUST document its payload in the queue
  docs/tests and confirm retry/lease semantics are unaffected. It adds new REST
  endpoints, a message `source` field, conversation ownership state, and a
  cursor-polled conversation event stream — OpenAPI + TypeScript SDK + MCP generated
  types MUST be regenerated, and the changes are additive/non-breaking where exposed
  publicly. No document-worker dispatch payloads change.
- **Observability**: suspension, notification, decision, resume, takeover, human
  reply, ownership transfer, and hand-back are new runtime paths and MUST be traced
  (new routine trace events: suspended / decision_notified / decision_applied; new
  conversation events for ownership changes) and append-only `hitl.decision` /
  `hitl.ownership` audit events MUST record who did what, when, and why — without raw
  prompts, completions, retrieved content, captured slot values, private operator
  notes, credentials, cookies, or connection strings.
- Modular boundaries between transport, orchestration, domain logic, and persistence
  MUST be preserved (see Architecture Constraints).

## Architecture Constraints *(mandatory)*

- **Boundary Rule — the suspend/resume primitive is generic and engine-owned**: the
  `await` step, the `awaitingDecision` result, and the resume entry point live in the
  conversation engine layer (contract + engine packages) and know nothing about
  approvals, refunds, operators, HTTP, email, or policy. They are reachable to serve
  any future external-decision flavor (escalation-with-resume, external-skill HITL),
  not just approval.
- **Boundary Rule — the gate lives where the risk is authored**: in this cut the gate
  is an authored routine step, so the routine compiler/authoring module owns "where a
  gate sits." The engine owns "how a paused step resumes." Risk policy (which actions
  auto-gate) is a future phase and will be settings data, not engine logic.
- **Boundary Rule — takeover is host-owned conversation state**: manual ownership is
  a backend conversation-control concern. It MUST NOT live in the conversation engine,
  routine runner, retrieval policy, prompt text, or message `role`. The AI path only
  receives turns after the host has proven the conversation is AI-owned.
- **Encapsulation Rule**: the chat orchestration service remains orchestration-only —
  it routes a turn into/out of suspension but MUST NOT own the pending-decision store,
  the decision validation, notification, ownership persistence, human-reply
  persistence, event-stream persistence, or audit construction. It may check ownership
  early enough to suppress the AI path. The conversation-actions outbox remains a
  fire-and-forget **dispatch** mechanism and MUST NOT gain decision lifecycle, an
  approve/reject transition, or a result channel — the pending-decision store is its
  sibling, not its extension. The skill dispatcher remains a dispatch chokepoint and
  is **not** modified in this cut (no deferred-skill parking).
- **New Seams Required**:
  - The `await` step kind + `awaitingDecision` result variant + `resumeAwaitingDecision`
    entry point in the conversation contract + engine packages (with a pure resume
    helper that is unit-testable with stubs, mirroring the clarification helper).
  - A `SuspendedRoutineReader` read port (`loadSuspended(handle)`), distinct from the
    active-routine store.
  - A new pending-decision store port + repository + migration (sibling to the
    conversation-actions outbox), plus extension of the turn-commit fence to persist
    the suspension atomically.
  - The `suspended` routine-state status + optimistic version guard on routine-state
    save (migration).
  - The authenticated, validated decision endpoint (sibling to the agent routes,
    which today own authoring CRUD only).
  - A decision-notification outbox action type + handler, registered through the same
    surface as the contact-send handler.
  - The per-message `source` discriminator (contract field + migration + persistence
    mapper + read rendering, with visible operator display-name metadata for human
    messages).
  - A conversation-ownership store/port + repository + migration, plus authenticated
    takeover, transfer, hand-back, and human-reply endpoints.
  - An AI-path suppression guard near the start of visitor-message handling — shared by
    **all** chat entry surfaces (public/embed, dashboard, REST API, MCP) so it cannot
    be bypassed — so manual ownership prevents model calls, routine activation,
    retrieval, skill dispatch, and action outbox writes.
  - A cursor-polled conversation event stream that reuses the existing history cursor
    shape and emits message, decision, and ownership events through one envelope.
  - The approval queue surface layered into the existing Quality view (new "needs
    approval" filter/signal + per-row decision controls), and source rendering in the
    conversation drawer.
  - A manual-ownership operator console state in the conversation drawer: take over,
    visible human reply, ownership transfer if allowed, and hand-back.
- **Anti-Goals**:
  - Do **not** model the suspension as a status flag on the single per-session routine
    state row (cannot hold concurrent decisions; races last-writer-wins).
  - Do **not** suspend at a skill step / make the skill dispatcher park a deferred
    skill in this cut (it would re-run the side effect on resume).
  - Do **not** route the operator resume through a `TurnContext` or a synthetic user
    message; the resume runner branch MUST skip user-message selection / slot
    extraction.
  - Do **not** widen the capability decision to a tri-state (`requires_approval`);
    keep it binary and gate by an authored step in this cut.
  - Do **not** build per-skill auto-gating, an autonomy dial, an end-user in-chat
    approval card, automated timeout/SLA handling, agent-assist drafting, or true
    push delivery (SSE/websockets) here.
  - Do **not** allow interject-alongside semantics where the AI keeps answering while
    a human operator also replies. Takeover means the human owns the conversation and
    the AI goes silent until hand-back.
  - Do **not** support silent "on behalf of the AI" human messages in this spec; human
    messages are visible and named.
  - Do **not** reuse the conversation id as the resume handle, and do **not** trust a
    UI affordance for authorization.
  - Do **not** encode decision options, gate reasons, or outcomes as English keyword
    lists or hard-coded conversational strings.
  - Do **not** let the engine package gain knowledge of HTTP, notification, or
    operator identity.

## Requirements *(mandatory)*

### Functional Requirements

#### Tranche A — approval MVP

- **FR-001**: A routine author MUST be able to declare an approval step that compiles
  to a runtime `await` step positioned before the side-effecting step it gates, with
  an authored option set, a capture key, and exactly one deterministic outgoing edge
  per outcome plus a fallback.
- **FR-002**: When a conversation reaches an `await` step, the system MUST suspend the
  routine, persist routine state as `suspended` together with a pending-decision row
  in a single transaction with the assistant turn, and render an LLM-authored
  "awaiting review" reply.
- **FR-003**: A suspended routine MUST NOT execute the gated downstream step or any
  side effect until an approving decision is applied.
- **FR-004**: The normal "load active routine for this session" path MUST exclude
  suspended routines, so an inbound user message does not resume or advance a
  suspended routine; such a message MUST be answered as a normal turn and MUST NOT
  cause a new routine to activate over the suspended one.
- **FR-005**: The system MUST resume a suspended routine only via an authorized
  decision, captured as a routine variable, with traversal starting **at** the gated
  step (no prior step re-run) and branching via the routine's deterministic guards.
- **FR-006**: The decision endpoint MUST be authenticated and MUST validate, server-
  side and in order: handle open; caller is a workspace member; caller satisfies the
  decision's decider scope; content hash matches; option valid — before any engine
  resume.
- **FR-007**: Decision resolution MUST be exactly-once (compare-and-set on the pending
  row); a redelivered, double-clicked, or concurrent second submission MUST be a
  no-op conflict and MUST NOT fire the gated action twice.
- **FR-008**: A decision recorded but interrupted before the resumed turn is persisted
  MUST be safely resumable on retry without re-prompting the human.
- **FR-009**: A suspended turn MUST be recorded as a distinct, non-answer outcome (not
  billed as an answered turn, distinct audit signal); the resumed turn is the
  answered/billed turn.
- **FR-010**: On creating a pending decision, the system MUST dispatch an out-of-band
  notification through the existing contact-delivery transport, carrying a single-use
  link to the decision, without blocking the turn.
- **FR-011**: The dashboard MUST present a queue of pending decisions showing, per
  item, the proposed action (from structured metadata), the gate reason (no raw
  confidence), the originating conversation, and the deadline, with overdue items
  visually distinguished; any authenticated member may read it; only authorized
  deciders may act.
- **FR-012**: Approving or rejecting from the queue MUST route through the same
  authenticated decision endpoint, with optimistic UI that reverts on failure, and
  MUST prevent two operators from double-handling the same decision.
- **FR-013**: Every persisted message MUST record a `source`
  (`customer | ai_agent | human_agent | human_agent_on_behalf_of_ai_agent | system`,
  the last value reserved/unused in this spec); `source` MUST be stored as an
  unconstrained `TEXT` column so adding the reserved value later needs no migration;
  existing rows MUST read back a `source` derived from their role; the field MUST be
  additive/optional on the public API, SDK, and MCP surfaces; operators MUST see the
  source when viewing a conversation.
- **FR-014**: Suspension, notification, decision application, and resume MUST emit
  routine trace events and an append-only `hitl.decision` audit event recording who
  decided what, when, and why it was gated — recording no raw prompts, completions,
  retrieved content, or captured slot values.
- **FR-015**: A decision MUST be bound to the exact proposal via a content hash; a
  decision whose submitted hash does not match the stored proposal MUST be rejected
  and the gated action MUST NOT ship under it.
- **FR-016**: A suspended routine MUST NOT be dropped by the existing routine-state
  abandon/expiry sweep; its abandon clock is paused while suspended. (Automated
  deadline resolution is out of scope; an overdue decision remains resolvable and is
  shown as overdue.)

#### Tranche B — takeover and hand-back

- **FR-017**: An authorized operator MUST be able to take over a conversation,
  changing conversation ownership to `human_owned` with owning operator identity,
  takeover timestamp, optional reason, version, and audit event.
- **FR-018**: While a conversation is `human_owned`, inbound visitor messages MUST be
  persisted and surfaced to operators but MUST NOT start an AI answer, routine
  activation/resume from visitor input, retrieval answer, model call, skill dispatch,
  or conversation-action outbox write. This suppression MUST hold across **every** chat
  entry surface — public/embed, dashboard, REST API, and MCP — so takeover cannot be
  bypassed by sending through a different endpoint.
- **FR-019**: A human reply during takeover MUST be persisted as a first-class message
  with `source: human_agent`, operator id, and operator display name, and MUST be
  visible to operators viewing the conversation. Visitor-facing delivery and rendering
  of the human display name is delivered through the US5 event stream (FR-023), not as
  a direct response to a visitor turn.
- **FR-020**: Manual ownership MUST end only through an explicit, authenticated
  hand-back action; after hand-back, the next visitor message MUST follow the normal
  AI-owned conversation path.
- **FR-021**: If ownership transfer between operators is supported, it MUST be an
  explicit authenticated server-side action with authorization, optimistic concurrency
  protection, and audit; otherwise only the owning operator or an authorized
  supervisor may reply or hand back.
- **FR-022**: Approval resume and takeover MUST have an explicit compatibility rule
  that distinguishes a **message-emitting resume** from a **side-effect-only resume**.
  A decision can be recorded during manual ownership, but a resume that would emit an
  AI-authored message into a `human_owned` conversation MUST be deferred until
  hand-back (decision retained, resume parked). A side-effect-only resume (gated action
  fires, no AI utterance) MAY proceed under manual ownership only when the host marks
  it side-effect-only/safe; otherwise it also defers. The default classification is
  message-emitting (defer).
- **FR-023**: Visitor and operator clients MUST be able to poll a conversation event
  stream using a cursor that reuses the existing conversation history cursor shape.
  The stream MUST include ordered message, decision, takeover, transfer, and hand-back
  events with stable event ids and next cursors.
- **FR-024**: The cursor event stream MUST be transport-neutral and idempotent so a
  later SSE/websocket transport can reuse the same event envelope and ordering
  semantics without changing conversation behavior.

### Key Entities

- **Pending Decision**: a decision a human must resolve before a suspended routine
  resumes. Attributes: opaque single-use **handle** (resume token + correlation key);
  conversation / workspace / agent scope; gated routine + step reference; offered
  **options** (id, label, optional opaque payload); **decider scope** (who may
  resolve); **content hash** (binds to the exact proposal); **deadline**; lifecycle
  status (`pending → approved | rejected | cancelled`); resolved decision, decider
  identity, decided-at. Sibling of the conversation-actions outbox, not part of it.
- **Suspended Routine State**: existing per-conversation routine position extended
  with a `suspended` status (excluded from active-routine load), an optimistic
  version, a paused abandon clock, and a way to be loaded by handle.
- **Decision**: an authorized human's resolution — chosen option id + optional opaque
  payload — validated by the host and handed to the engine, captured as a routine
  variable that the routine's deterministic guards branch on.
- **Message Source**: a per-message attribution discriminator orthogonal to chat role
  (`customer | ai_agent | human_agent | human_agent_on_behalf_of_ai_agent | system`;
  the last value is reserved/unused in this spec, stored as unconstrained `TEXT`).
  Human messages carry operator id and display name for visible attribution.
- **Conversation Ownership**: per-conversation state (`ai_owned | human_owned`) with
  owning operator, version, timestamps, optional reason, and audit correlation.
- **Conversation Event**: ordered pollable event envelope for message creation,
  decision lifecycle, takeover, transfer, and hand-back; carries source/actor
  metadata, stable event id, and cursor.
- **Decision Notification**: an outbox action (transport only) carrying a single-use
  link, delivered via the per-agent contact-delivery transport.
- **HITL Decision Audit Event**: append-only record of who decided what, when, why it
  was gated, and the proposal content hash.
- **HITL Ownership Audit Event**: append-only record of takeover, human reply,
  transfer, and hand-back actors/timestamps/reasons without private notes or raw
  conversation content.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A gated side effect **never** executes before an approving decision is
  recorded, and **never** executes on rejection — 100% across the test suite,
  including the double-submit, redelivery, crash-before-resume, and stale-hash cases.
- **SC-002**: On approval, the routine resumes at the gated step and executes the
  gated action **exactly once**; on rejection it follows its rejection path and the
  action executes **zero** times — verified by integration tests.
- **SC-003**: A crash after a decision is recorded but before the resumed turn is
  persisted never re-prompts the human, and resume is idempotent on retry.
- **SC-004**: While a routine is suspended, an inbound visitor message is answered as
  a normal turn and the suspended routine is neither advanced nor dropped; it is still
  resolvable after the visitor's intervening messages.
- **SC-005**: An authorized operator can take a gated conversation from "pending" to
  "resumed" entirely from the dashboard queue (find → review → decide) without using
  an API client.
- **SC-006**: A decision submitted by an unauthorized member is rejected by the server
  regardless of UI state; authorization does not depend on any client affordance.
- **SC-007**: Every message persisted after this feature carries a `source`; existing
  conversations read back with a role-derived source and render without error; no
  existing API/SDK/MCP consumer breaks (additive field).
- **SC-008**: Every suspension and decision is reconstructable from the trace and the
  audit event (who/what/when/why) with no raw prompts, completions, retrieved content,
  or slot values present in either.
- **SC-009**: During manual ownership, a visitor message results in zero AI model
  calls, zero retrieval answer attempts, zero skill dispatches, and zero AI response
  messages; the message remains visible to the owning operator.
- **SC-010**: A human takeover reply renders to the visitor with the operator display
  name and `source: human_agent`; no human reply is rendered as AI-authored.
- **SC-011**: Explicit hand-back restores the normal AI-owned path for the next
  visitor message and records an ownership audit event.
- **SC-012**: Repeated cursor polls from visitor and operator clients produce stable,
  ordered event ids with no duplicate rendering and no dependency on websockets or
  SSE.

## Assumptions

- The first-cut gate is an **authored** approval step (the routine author places it).
  Per-skill auto-gating and an autonomy dial are a deliberate later phase; this spec
  does not require a risk classifier.
- The deciding party in this cut is an **operator** (authenticated workspace member).
  End-user in-chat consent is a later phase.
- Pending decisions are **non-blocking** for the visitor: while a decision is
  out-of-band, the visitor may keep chatting and is answered normally.
- Takeover is different from pending approval: while takeover is active, the human
  owns the conversation and the AI does not answer visitor messages until explicit
  hand-back.
- The first takeover transport is cursor polling, not websockets/SSE. The event
  envelope is designed so true push can be added later without changing the semantic
  contract.
- Visitor-side polling is **new work**, not reuse (verified 2026-06-17): a
  session-bound visitor read endpoint exists
  (`GET /api/v1/public/chat/:token/history/:conversationId`), but it is a full-detail
  GET and visitors receive content today only as the streamed response to their own
  send. US5 adds incremental cursor/delta semantics and visitor polling, and the
  event-stream backing store (append-only `conversation_events` table vs ordered union)
  is an explicit planning decision — this is the heaviest build in the feature.
- Human-authored takeover replies are visible and named. Silent human replies that
  preserve a single-agent illusion are intentionally not supported in this spec.
- A suspended turn is **not billed**; only the resumed answer turn is. (To be
  confirmed against the usage-metering model during planning.)
- Notification recipients reuse the existing per-agent contact-delivery configuration;
  this spec introduces no new recipient-config surface.
- The engine's resume runner branch can start traversal on the gated step and skip
  user-message selection / slot extraction. **RESOLVED by spike (2026-06-17 — see
  `.context/hitl-spike-runner-resume.md` and the seed test
  `packages/conversation-engine/tests/spike-resume-awaiting-decision.test.ts`): option
  (a) — the *existing* `DefaultRoutineRunner.resume()` already does this with NO source
  change and NO model call.** When the gate step's outgoing edges are deterministic
  `field`/`slot_filled` guards and the decision is pre-injected as a routine variable,
  `selectNext` branches in code (`routineRunner.ts:398-402`) and never consults the
  selector; a control case with `llm` edges confirms the model *is* called otherwise,
  so the result is causal. The remaining work is host/engine glue (a new
  `resumeAwaitingDecision` entry point that flips status to active and calls
  `resume()` **without** appending a synthetic user input event — unlike
  `attemptRoutine`) plus the suspend-side `await` step kind, not a new runner walk.
  This makes the following **compiler/authoring invariants** mandatory (planning to
  enforce): the `await` step's decision edges MUST be deterministic guards (no `llm`
  edge); the `await` step MUST NOT declare `metadata.collectsSlots`; and the gated
  side-effecting step MUST sit *after* the gate so resume (which starts at the gate
  step) reaches it for the first time post-approval, never re-running prior steps.
- Deadlines are recorded and displayed in this cut, but **automated** timeout
  resolution (auto-reject / escalate) is a later phase.

## Dependencies

- **Conversation engine + routine runner** (`packages/conversation-contract`,
  `packages/conversation-engine`): the `await` step, `awaitingDecision` result, and
  resume entry point extend these; resume must respect the runner's fast-forward
  behavior (`project_routine_runtime_quirks`).
- **Clarification capability** (spec 085): the resume **shape** (ask → persist →
  resume) and the engine/host ownership split are the template; this feature
  generalizes them to a non-user decider. No change to clarification is required.
- **Conversation actions / outbox** (spec 070): reused as the notification transport
  (new action type + handler) and as the model for atomic turn-commit; not extended
  into a decision store.
- **Routines as data** (spec 082) and routine authoring/compiler: the new `approval`
  step kind extends the authoring vocabulary, compiler, and validator.
- **Per-agent skill settings / contact delivery** (specs 071, contact feature): the
  notification recipients reuse the existing delivery resolver.
- **Quality / triage view** and the conversation drawer (frontend): host the approval
  queue, source rendering, manual ownership controls, and cursor-polled event
  updates.
- **Auth & workspaces**: the decision endpoint reuses workspace-member authentication
  and permission checks for decider scope; takeover, human reply, ownership transfer,
  and hand-back reuse workspace-member authentication plus ownership-specific
  permission checks.
- **EE/OSS boundary** (spec 058 family): the entire first cut is OSS and edition-
  neutral; no EE endpoint/env/schema is referenced. (A `human_approval.request`
  capability as the EE on/off seam arrives with the later per-skill auto-gating phase.)

## Out of Scope — Future Phases

The following are intentionally **not** in this spec and are sequenced as later
phases in `.context/hitl-design-memo.md` (§8):

- **In-chat end-user approval card** (the visitor is the decider; streamed `onPaused`
  SSE event).
- **Per-skill `requiresApproval` gate + autonomy dial** (supervised → exception-only
  → sampled → auto) with a risk policy; the `human_approval.request` capability as the
  EE seam.
- **Automated timeout / SLA sweep + escalation** (fail-safe auto-reject / escalate to
  a backup decider).
- **Agent-assist drafting** (AI drafts for the operator to edit/send; AI never
  auto-commits).
- **Interject-alongside mode** (human drops a message while the AI continues
  answering).
- **Silent human-on-behalf-of-agent replies** that hide the human identity.
- **True push realtime transport** (SSE/websockets). The cursor event stream is the
  v1 transport; future push must reuse its event envelope.
