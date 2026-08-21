# Feature Specification: Live push updates for operator surfaces

**Feature Branch**: `live-push-updates`
**Spec**: `106-live-push-updates`
**Created**: 2026-08-20
**Status**: Draft
**Input**: User description: "In many places — activity, document crawl, requires attention, others — there is a need to refresh the page to see the updates. Can there be a mechanism to push the updates to the frontend? Find all places where it would make sense. And the pushes probably need to be durable."

## Clarifications

### Session 2026-08-20

- **The push channel is ephemeral, not durable.** Push frames are content-free invalidation
  hints that carry resource identity and a monotonic version only; the client re-reads
  authoritative state from PostgreSQL. Correctness is guaranteed by *convergence*
  (refetch-on-reconnect + a slow reconcile poll floor + a version guard), not by durable
  delivery. Durable per-client queues, replay logs, or acked delivery are explicitly rejected as
  solving a problem convergence already solves more cheaply. See `research.md` for the rationale.
- **Polling is retained as the floor, never removed.** Push is an optimization layered over a
  slowed reconcile poll. If push fails end-to-end, every surface must still converge on its own.
- **The transport must cross process and instance boundaries.** Document and crawl status
  transitions occur in a separate worker process, and production runs multiple API instances.
  The in-process `InMemoryPublicConversationEventBus` cannot serve these surfaces; the bus must
  fan out across processes and instances (Postgres `LISTEN/NOTIFY` is the recommended backing).
- **Scope is workspace-scoped operator surfaces.** One authenticated dashboard push channel per
  workspace session. End-user/embedded widget push already exists and is out of scope except
  where it shares the generalized bus.
- **Requires-attention keeps its operator-pull model.** Push makes the new-item *count* instant;
  it does not auto-inject new items into the operator's working list. The deliberate "Refresh
  (N)" affordance stays.
- **Frames carry identity, never content.** No prompts, completions, document bodies, retrieved
  chunks, tokens, or PII cross the push channel — only resource type, id, workspace, a change
  kind, and a version.
- **The frame `version` MUST be genuinely monotonic per resource** (a row revision counter or a
  commit-ordered event sequence), never a transaction-start timestamp. `currentTimestamp()` in
  this repo is `now()` (transaction-start), so `updated_at` is not commit-ordered and is unsafe as
  the version guard's key. The version guard coalesces bursts but never suppresses the trailing
  refetch, so even a version anomaly degrades to a redundant fetch, not staleness.
- **Crawl push covers every visible status transition**, not just terminal ones. The UI
  distinguishes queued/processing/paused, so `crawl.status_changed` fires on claim (`claimNext`
  *and* the `claimById` path used by the production `runJobById` task/AMQP dispatch), pause,
  resume, stale release, and queued re-entry as well as completed/failed; `crawl.progress` fires
  on checkpoint updates.
- **History invalidation publishes from the conversation lifecycle, not the message bus hook.**
  `publishMessageCreated` is wired only for the public widget bus and the approval-resume path, so
  it never fires for ordinary assistant turns; History must publish from conversation create and
  `conversationRepository.touch` (`chatTurnLifecycle.ts`) so normal new/ongoing visitor
  conversations invalidate the list.
- **"All activity" is a merged feed, not conversation-only.** The `/history` view includes
  document-search (`kind: "search"`) entries alongside conversations, so it needs a
  `search.created` invalidation (fired on the `document.search` audit write) in addition to the
  `conversation.*` events; the chat-only and contact sub-filters do not.
- **The `conversations` row is nearly stateless — do not model a single "conversation lifecycle"
  stream.** The row carries only `updated_at` + `verified_customer_id`; the operator-relevant
  state lives in sibling tables (`conversation_ownership`, `routine_action_requests`,
  `pending_decisions`, quality on `messages`). Two consequences: (1) operator takeover / transfer /
  handback mutate `conversation_ownership` **without** touching the conversation, so
  `conversation.updated` (keyed on `conversations.updated_at`) silently misses them — needs a
  distinct `conversation.ownership_changed` event feeding the needs-attention human-owned list and
  the rail badge; (2) contact-request delivery transitions run in the **worker** and never touch
  the conversation, so they need a distinct `conversation.contact_delivery_changed` event. This
  compounds the monotonic-version rule: `conversations.updated_at` is unusable as an invalidation
  key both because it is not commit-ordered AND because it does not move for these transitions.
- **Surfaces subscribe to resource change-kinds, not to "the conversation lifecycle."** The
  needs-attention inbox is a composition of three orthogonal feeds (HITL decisions, human-owned
  conversations, answer-quality inbox); each publishes its own event. Do not fold HITL decisions or
  answer quality into conversation events — they are not conversation lifecycle.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Watch document ingestion progress without refreshing (Priority: P1)

As an operator who just uploaded documents or started a crawl, I want the documents list and
crawl progress to update on their own so I can see processing finish without reloading the page.

**Why this priority**: This is the surface the user named first and the one with a real
correctness gap today — status transitions happen in a worker process the browser can never reach
in-process, and the existing 2s poll loop can un-arm on pagination/filtering, stranding the UI.

**Independent Test**: Upload a document (or start a crawl) with the list open and untouched, then
confirm the row moves `queued → processing → ready` and crawl progress advances without any
manual refresh, including when the list is paginated/filtered so the changing item is not on the
visible page's poll gate.

**Acceptance Scenarios**:

1. **Given** the documents list is open, **When** a document the worker is processing flips to
   `ready`, **Then** its row updates within a few seconds with no operator action.
2. **Given** a crawl job is running, **When** the worker updates its checkpoint (pages crawled),
   **Then** the crawl progress indicator advances without a manual refresh.
3. **Given** the browser's push connection drops and reconnects, **When** it reopens, **Then** the
   client performs a full refetch of the visible slice and shows any status changes that occurred
   while it was disconnected.
4. **Given** push is unavailable end-to-end (transport down), **When** documents change status,
   **Then** the surface still converges via the slow reconcile poll floor.
5. **Given** a late push hint arrives carrying an older version than the client already holds,
   **When** it is processed, **Then** it is ignored and does not regress the displayed state.

---

### User Story 2 — See new attention items and conversations arrive live (Priority: P1)

As an operator monitoring the inbox and activity, I want new needs-attention items and new
conversations to be signalled the moment they occur so I am not acting on a stale view.

**Why this priority**: The needs-attention list only updates its badge every 15–30s and requires
a manual click to load; the History / "All activity" list does not auto-update at all.

**Independent Test**: With the needs-attention view and, separately, the History list open,
generate a new pending decision and a new conversation, and confirm the attention count updates
promptly and the History list reflects the new conversation without a full page reload.

**Acceptance Scenarios**:

1. **Given** the needs-attention view is open, **When** a new pending decision is created, **Then**
   the "Refresh (N)" count updates promptly (seconds, not up to 30s) while the displayed list stays
   stable until the operator chooses to load it.
2. **Given** the History / "All activity" list is open, **When** a new conversation is created or
   an existing one gains activity (an ordinary visitor assistant turn, not only a widget/operator
   reply), **Then** the list converges to include it without a manual page reload.
3. **Given** the "All activity" merged feed is open, **When** a new document-search entry is
   recorded, **Then** it appears without a manual reload (the merged feed is not conversation-only).
4. **Given** an operator resolves a decision, **When** the action completes, **Then** the operator's
   own list refresh continues to work as today (push does not replace action-driven refresh).
5. **Given** a conversation drawer is open, **When** its tail updates, **Then** the existing live
   1s tail behavior is preserved (unchanged by this feature).

---

### User Story 3 — Push never leaks content and never strands the UI (Priority: P2)

As a platform operator, I want the push channel to be safe and self-healing so it cannot leak
conversation content and cannot leave a surface permanently stale.

**Why this priority**: A workspace-scoped firehose is a new cross-cutting runtime path; its safety
and failure behavior must be explicit before it ships.

**Independent Test**: Inspect emitted frames and confirm they contain only identity + version;
kill the transport and confirm every surface still converges via its poll floor; confirm a
subscriber only ever receives events for its own workspace.

**Acceptance Scenarios**:

1. **Given** any push frame, **When** it is inspected, **Then** it contains only resource type,
   resource id, workspace id, change kind, and version/timestamp — no prompts, completions,
   document/chunk content, tokens, or credentials.
2. **Given** a subscriber authenticated for workspace A, **When** an event occurs in workspace B,
   **Then** the subscriber never receives it.
3. **Given** all API instances restart during a deploy so a `NOTIFY` is dropped, **When** the
   client reconnects, **Then** refetch-on-reconnect plus the reconcile floor restore a correct
   view.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** The system MUST expose a single authenticated, workspace-scoped push channel for the
  dashboard (one long-lived SSE connection per dashboard session), reusing the existing
  `sendChatSse` / `streamChatEvents` seams generalized for typed non-chat frames.
- **FR-002** The system MUST deliver push frames that occur in **any** process (API or worker) and
  on **any** instance to the browser holding the channel, via a cross-process/cross-instance bus.
- **FR-003** Push frames MUST be invalidation hints carrying only `{ resourceType, resourceId,
  workspaceId, changeKind, version }` — never resource content.
- **FR-004** The client MUST respond to a frame by re-reading authoritative state through existing
  fetch paths for the affected surface. The `version` guard MUST only be used to **coalesce** a
  burst of hints (dedupe/debounce); it MUST NOT suppress the trailing refetch. The client MUST
  always perform one refetch after the last hint in a burst, so that even a version anomaly
  degrades to a redundant fetch (which reads latest committed state), never to staleness. Frame
  `version` MUST be the monotonic per-resource value defined under Key Entities, never a
  transaction-start timestamp.
- **FR-005** On channel open and every reconnect, the client MUST refetch the visible slice of each
  subscribed surface.
- **FR-006** Each surface MUST retain a reconcile poll floor (slower than today's cadence) that
  guarantees convergence when push is unavailable; the floor MUST NOT be removed.
- **FR-007** Publish sites MUST be the existing state-transition points, adding a publish
  alongside the existing audit/telemetry emission without altering transition logic. A publish
  site MUST NOT be omitted for a transition the UI renders. **The operator-relevant conversation
  lifecycle is NOT a single stream keyed on `conversations.updated_at`** — that row is nearly
  stateless (only `updated_at` + `verified_customer_id`); the state operators watch lives in
  sibling tables (`conversation_ownership`, `routine_action_requests`, `pending_decisions`,
  quality), several of which transition **without touching the conversation** (and one in the
  worker). Each is its own `resourceType`/`changeKind`, not folded into `conversation.updated`:
  - **Documents:** `documentRepository.setStatus*` / `chunkRepository.publishForDocumentRevision`.
  - **Crawl:** `create`, `claimNext`, **`claimById`** (the production `runJobById` task/AMQP path
    claims by id, a queued→processing transition just like `claimNext`), `pauseBySourceId`,
    `resumePausedBySourceId`, `releaseTimedOutClaim`, `releaseAllTimedOutClaims`,
    `releasePausedClaim`, `updateCheckpoint`, `markCompleted`, `markFailed`.
  - **Conversation (activity):** conversation create and `conversationRepository.touch`
    (`chatTurnLifecycle.ts`) → `conversation.created` / `conversation.updated`. NOT
    `publishMessageCreated` (wired only for the widget bus + approval-resume; silent on ordinary
    turns).
  - **Conversation ownership / handoff:** `conversationOwnershipRepository.requestHandoff`,
    `takeOver`, `transfer`, `handBack` (routes `conversationOwnershipRoutes.ts` + the Slack
    interactivity handler) → `conversation.ownership_changed` (API process). CRITICAL:
    `takeOver`/`transfer`/`handBack` mutate only `conversation_ownership` and do **not** `touch`
    the conversation, so `conversation.updated` alone silently misses operator takeover/transfer/
    handback — the needs-attention human-owned list and rail badge depend on this event.
  - **Contact-request delivery:** `actionRequestRepository.claimPending` / `markDispatched` /
    `recordFailure` (via `ActionDispatcher`) → `conversation.contact_delivery_changed`
    (**WORKER process** — action-dispatch drain; these never touch `conversations`, so a
    conversation-touch stream misses 100% of delivery-status changes).
  - **HITL:** `pending_decisions` create/resolve writes → `hitl.decision_created` /
    `hitl.decision_resolved`.
  - **Answer quality (needs-attention quality inbox):** answer-feedback writes
    (`answerFeedbackService.ts`) and triage-state writes (`quality/triageStore.ts`) →
    `quality.feedback_changed` / `quality.triage_changed` (API process). Not conversation
    lifecycle; the inbox composes it independently.
  - **Document search (for "All activity"):** the `document.search` audit-event write on the
    retrieval/search request path → `search.created`, so document-search entries in the merged
    history invalidate too.
- **FR-008** The generic transport and bus MUST NOT know about documents, crawl, or HITL
  specifically; domain modules publish typed events through a narrow port, and app composition
  wires the concrete bus (per `backend/src/app/composition/`).
- **FR-009** A subscriber MUST only receive events for its authorized workspace; cross-workspace
  leakage MUST be impossible.
- **FR-010** The channel MUST heartbeat and auto-reconnect (following the existing public-chat
  events channel behavior) and MUST degrade to poll-only cleanly when unavailable.
- **FR-011** The needs-attention surface MUST use push to update its new-item count instantly while
  preserving the operator-pull "Refresh (N)" model; it MUST NOT auto-inject items into the list.
- **FR-012** Observability MUST be added for the new runtime path (connection open/close,
  reconnects, publish counts, dropped/lossy signals) without high-cardinality metrics or content
  in logs.

### Surface coverage map

Priority order for adopting the channel. Surfaces are additive — the channel ships once, surfaces
opt in.

| Surface | Change kind(s) | Priority | Notes |
|---|---|---|---|
| Document list status | `document.status_changed` | P1 | Worker-process origin — the case that forces the cross-process bus |
| Crawl job status + progress | `crawl.status_changed`, `crawl.progress` | P1 | Worker-process origin. `crawl.status_changed` MUST cover EVERY visible transition, not just terminal ones: `create` (→queued), `claimNext` **and `claimById`** (→processing; `claimById` is the production `runJobById` task/AMQP claim path), `pauseBySourceId` (→paused), `resumePausedBySourceId` (→queued), `releaseTimedOutClaim`/`releaseAllTimedOutClaims`/`releasePausedClaim` (stale release → queued re-entry), `markCompleted`, `markFailed`. `crawl.progress` covers `updateCheckpoint` (pages-crawled advances without a status change). The UI distinguishes queued/processing/paused, so omitting any transition (or the id-claim path) would leave a crawl visibly stuck until the reconcile floor. |
| Requires attention (count) | `hitl.decision_created`, `hitl.decision_resolved`, `conversation.ownership_changed`, `quality.feedback_changed`, `quality.triage_changed` | P1 | The inbox is a **composition of three orthogonal feeds**, not one: HITL pending decisions, human-owned conversations (`conversation_ownership.state`), and the answer-quality inbox. Subscribing only to `hitl.*` misses (a) operator takeover/transfer/handback — which mutate `conversation_ownership` without touching the conversation — and (b) new thumbs-down/triage items. Keeps "Refresh (N)" pull model. |
| History / "All activity" list | `conversation.created`, `conversation.updated`, `search.created` | P1 | Only surface with no auto-update today. Publish from conversation create + `conversationRepository.touch` (ordinary assistant turns), **not** `publishMessageCreated` (widget/approval-only). The "All activity" (`/history`) view is a **merged** feed — it includes `kind: "search"` document-search entries, not just conversations — so `search.created` (fired on the `document.search` audit write) is required or that slice stays load-once. The chat-only (`/history/chat`) and contact (`/history/contact`) sub-filters need only the `conversation.*` events. |
| Rail/inbox badge | reuse `hitl.*` + `conversation.ownership_changed` | P2 | Badge = pending decisions + human-owned conversation total, so it needs the ownership event too, not just `hitl.*` |
| Contact-request delivery (drawer + contact filter) | `conversation.contact_delivery_changed` | P3 | Worker-origin (action-dispatch drain), never touches the conversation. Drawer detail is drawer-open/tail today; the History `/history/contact` filter shows a `contact.status` column. Optional — small surface, but the only way its status goes live |
| Conversation trace (drawer) | — | P3 | Already live via 1s tail; optionally migrate later |
| Operator Copilot / Agent Wizard | — | out | Already stream, session-scoped |
| Embedded widget events | reuse existing `message.created` | out | Existing channel; migrate onto the generalized bus opportunistically |
| Usage / trends / AI-usage tiles | — | poll-only | `usage-view.tsx` / `usage-trends-view.tsx` / `usage-details-view.tsx`. On-request coarse aggregates (day/week/month buckets) over live tables; already have manual Refresh + Apply-filters. The `usage_events` ledger is worker-written, but the surface is not real-time-critical — an in-flight turn just increments today's bucket invisibly. Excluded. |
| Action outbox delivery status | — | poll-only | Raw outbox (`routine_action_requests`, worker-written) is **not surfaced** in any operator view. Webhook last-delivery is a load-once Settings summary (`webhook-destinations-panel.tsx`); contact-request status is per-conversation in the drawer (already 4s tail-polled). No aggregate outbox-health surface exists. Excluded. *Optional P3:* add a poll/refresh (not push) to the webhook-destinations delivery summary, which is load-once today. |
| Directive / routine runtime state | — | poll-only | Transitions run in the API process during the turn; no standalone live surface renders directive firing/expiry or routine path/variables — only the per-conversation drawer trace (already 4s tail-polled, out of scope). The one operator-actionable slice — routines suspended for approval — is already covered by the needs-attention `hitl.*` events above. Excluded. |

All candidate surfaces raised in review are now resolved in the table: none of usage/trends,
action-outbox, or directive/routine state adopt the push channel. Rationale is recorded per row;
the only follow-up is the optional poll (not push) on the webhook-destinations summary.

### Key Entities

- **PushEvent** — the invalidation hint: `resourceType`, `resourceId`, `workspaceId`, `changeKind`
  (enum), `version`. No content fields. `version` MUST be a genuinely monotonic per-resource
  value — a row revision counter or a commit-ordered event sequence — **not** a transaction-start
  timestamp. In this repo `currentTimestamp()` is `sql\`now()\``, which is transaction-start time,
  so `updated_at` is NOT commit-ordered: two overlapping writers can commit in the opposite order
  to their `updated_at` values, and a version guard keyed on it could drop the actually-final
  invalidation. `documents` already carries a `revision` column (used by
  `setStatusIfRevisionMatches`) that is a suitable source; resources without one need a revision
  counter or a shared event sequence added.
- **WorkspaceEventBus (port)** — narrow publish/subscribe interface: `publish(PushEvent)` and
  `subscribe(workspaceId) → AsyncIterable<PushEvent>`. Domain modules depend on the port; the
  concrete Postgres `LISTEN/NOTIFY` (or in-memory, for single-process tests) implementation is
  wired in composition. The existing `InMemoryPublicConversationEventBus` becomes one
  implementation behind this port.
- **Push channel (transport)** — the SSE endpoint + client hook: authenticates the workspace,
  subscribes the bus, serializes `PushEvent` frames, heartbeats, and reconnects. Knows nothing of
  document/crawl/HITL semantics.
- **Resource namespaces (the event model)** — `resourceType` spans several independent
  namespaces: `document`, `crawl`, `conversation`, `ownership`, `contact_delivery` (action
  outbox), `hitl_decision`, `quality`, `search`. An operator surface subscribes to the set of
  `changeKind`s it composes from — the needs-attention inbox to `{hitl.*, ownership.*, quality.*}`,
  History to `{conversation.*, search.created}`, documents to `{document.status_changed}`. What is
  shared is the transport + workspace scoping + subscribe-by-changeKind mechanism — **not** a
  conversation-centric event model. Surfaces are NOT tied to "the conversation lifecycle"; they are
  tied to the specific resource changes they render. This keeps the bus ignorant of surface
  semantics and prevents over-coupling orthogonal feeds (e.g. HITL decisions and answer quality are
  not conversation events and must not be folded into one).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** With push healthy, an operator sees a document reach `ready`, a crawl advance, a new
  attention item counted, and a new conversation appear in History — all **without a manual page
  refresh**, within a few seconds of the underlying change.
- **SC-002** Turning the transport off leaves every surface still converging via its reconcile
  floor (no permanently stale surface); the only observable difference is latency.
- **SC-003** No push frame ever carries conversation content, document bodies, tokens, or
  credentials, verified by contract test.
- **SC-004** A subscriber never receives an event outside its workspace, verified by test.
- **SC-005** Steady-state background polling volume on the covered surfaces drops materially versus
  today (the 2s document/crawl loops and 15–30s inbox polls give way to a slow reconcile floor).

## Boundaries & Non-Goals

- **Not durable delivery.** No per-client queues, replay logs, or acked/exactly-once delivery.
  Convergence replaces durability.
- **Not a notifications inbox.** Persisted, must-not-miss, one-shot notifications ("export ready")
  are a separate feature with their own table; this channel would only be the live hint for it.
- **Not a new storage system.** Backing is Postgres (`LISTEN/NOTIFY`); no Redis/Kafka introduced.
- **Not changing the needs-attention product behavior.** Operator-pull "Refresh (N)" stays; only
  its latency improves.
- **Not fine-grained payloads first.** Frames invalidate + refetch; richer per-event payloads can
  come later without changing the contract's identity/version core.
