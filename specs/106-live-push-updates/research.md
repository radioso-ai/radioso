# Research: Live push updates for operator surfaces

**Spec**: `106-live-push-updates`
**Created**: 2026-08-20
**Status**: Draft input

This file captures the current-state map that motivates the spec. It is background, not
requirements — see `spec.md` for the normative statements.

## Current-state inventory

### Existing real-time infrastructure

- **No WebSockets, no `socket.io`/`ws`, no Postgres `LISTEN/NOTIFY`, no Redis pub/sub.** All
  real-time today is **SSE** (`text/event-stream`) consumed via `fetch` +
  `ReadableStream.getReader()` (native `EventSource` is avoided because they need POST bodies +
  auth headers).
- **Reusable SSE server pattern:** `backend/src/app/http/presenters/chatPresenter.ts` →
  `sendChatSse(res, AsyncIterable<ChatStreamEvent>)`. Sets `text/event-stream`,
  `X-Accel-Buffering: no`, writes named frames. Canonical "async iterable → SSE frames" server
  seam.
- **Reusable SSE client pattern:** `frontend/lib/api-chat-stream.ts` →
  `streamChatEvents(response, handlers)` + `parseSseEvent()`. Canonical client consumer.
- **Request-scoped streamers (token streaming, not push):** dashboard assistant chat
  (`assistantRoutes.ts` `streamAnswer`), public/embedded widget chat (`publicChatRoutes.ts`),
  Operator Copilot (`operatorCopilot/routes.ts` `POST /copilot/turns`), Agent Wizard
  (`agentWizard/routes.ts` `POST /analyze-website/stream`).

### The one existing server→browser push channel

- **Endpoint:** `GET /api/v1/public/chat/:token/events/:conversationId`
  (`publicChatRoutes.ts:753-820`). Long-lived SSE, 25s heartbeat, emits `ready` then
  `message.created`.
- **Bus:** `backend/src/modules/chat/services/publicConversationEventBus.ts` —
  `InMemoryPublicConversationEventBus`, a `Map<conversationId, Set<listener>>`. Instantiated in
  `backend/src/app/server/dependencies.ts`, published from
  `backend/src/app/server/builders/chat.ts` (`publishMessageCreated`).
- **Client:** `frontend/lib/api-public-chat.ts` `streamConversationEvents()`, driven by
  `frontend/lib/anonymous-chat-context.tsx` with auto-reconnect. Lets the embedded widget learn
  when a human/HITL operator replies.
- **Constraints:** keyed per-`conversationId` (not workspace-scoped); **in-memory / single
  instance** (no cross-instance fan-out); carries one event type today.

### Per-surface refresh behavior

| Surface | Files | Fetch mechanism | Refresh today |
|---|---|---|---|
| History / "All activity" list | `chat-history-view.tsx` → `history/history-list.tsx`, `history/use-chat-history-state.ts` | `loadHistory` → `/history`, `/history/chat`, `/history/contact`, `/history/search` | **Load-once per (filter, page, workspace). No poll, no refresh button.** |
| Requires attention (HITL) | `needs-attention-view.tsx`, `hooks/use-needs-attention-activity.ts`, `lib/api-hitl.ts`, `lib/needs-attention-quality.ts` | `refreshInbox` = `/decisions` + `/history/chat?ownership=human_owned` + quality inbox | Badge count auto-polls 15s fg / 30s bg (paused while a drawer is open); **list itself needs a manual "Refresh (N)" click** or an operator action / drawer close |
| Rail/inbox badge | `hooks/use-inbox-count.ts` | `/decisions` + `/history/chat` | 30s count poll |
| Conversation trace (drawer) | `conversation-drawer.tsx` → `ActivityTraceDetail`, `hooks/use-conversation-tail.ts` | `/history/chat/{id}/tail` (cursor) | Live 1s tail while drawer open |
| Document list status | `dashboard/documents-view.tsx`, `documents/document-status.tsx` | `loadDocuments` → `/document...` | Self-arming 2s `setTimeout` poll, **gated on any visible doc being `queued`/`processing`** |
| Crawl job progress | `documents-view.tsx`, `documents/document-crawl-jobs-banner.tsx`, `lib/api-documents.ts` | `listCrawlJobs()` → `/document/crawl/jobs` | 2s poll while any visible job non-terminal (route comment: "polls GET /jobs every 2s while jobs are non-terminal") |

Known polling gating gaps (documents/crawl): the poll loop only re-arms on `queued`/`processing`
in the *currently visible* page, so pagination/filtering, an unrecognized intermediate state, or
a first-fetch race can leave the loop un-armed and the UI stale until a manual action.

### Backend status-transition points (candidate publish sites)

- **Document status** (`pending → queued → processing → ready|failed`): writes go through
  `documentRepository.setStatus()` / `setStatusIfRevisionMatches()`, plus the final `ready` flip
  inside `chunkRepository.publishForDocumentRevision()`. Owned by the `documents` module state
  machine (`documentProcessingService.ts`, `documentProcessingWorker.ts`). These transitions run
  in the **separate document worker process** (`documentWorker.ts`).
- **Crawl job status** (`queued | processing | paused | completed | failed`):
  `websiteCrawlJobRepository.ts` — `create`, `claimNext`, **`claimById`** (production `runJobById`
  task/AMQP path; `worker.ts:84`), `pauseBySourceId`, `resumePausedBySourceId`, the three
  `release*` methods, `updateCheckpoint` (progress), `markCompleted`, `markFailed`. Driven by
  `websiteCrawler/worker.ts`. Also worker-process.
- **HITL / needs-attention:** `pending_decisions` create/resolve writes, in the **API process**.
- **History / conversations:** `conversationRepository.touch` (`chatTurnLifecycle.ts:764/847/982/988`)
  and conversation create, in the **API process**. NOTE: the existing `publishMessageCreated`
  (`chat.ts:862`, `approvals/service.ts:142`) is wired only for the public widget bus and
  approval-resume — it does NOT fire on ordinary assistant turns, so History push must hook the
  conversation lifecycle, not that bus.
- **Conversation is nearly stateless — lifecycle lives in sibling tables.** The `conversations`
  row changes only `updated_at` + `verified_customer_id`. Operator-relevant state is elsewhere:
  - **Ownership / handoff** (`conversation_ownership`, `conversationOwnershipRepository.ts`):
    `requestHandoff` (rides a turn touch), `takeOver` / `transfer` / `handBack` (routes +
    `slackInteractivityHandler.ts`). **API process.** CRITICAL: takeOver/transfer/handBack do NOT
    `touch` the conversation, so `conversations.updated_at` does not move — needs a distinct
    `conversation.ownership_changed`. Feeds the needs-attention human-owned list + rail badge.
  - **Contact-request delivery** (`routine_action_requests`, `actionRequestRepository.ts`):
    `claimPending` / `markDispatched` / `recordFailure` via `ActionDispatcher`. **WORKER process**
    (action-dispatch drain) — never touches `conversations`. Needs `conversation.contact_delivery_changed`.
  - **Answer quality** (`messages` + `quality/triageStore.ts`): thumbs-down feedback
    (`answerFeedbackService.ts`) + triage state. **API process.** Separate from conversation
    lifecycle; the needs-attention quality inbox composes it. Needs `quality.feedback_changed` /
    `quality.triage_changed`.
- **Document search (for the merged "All activity" feed):** the `document.search` audit write on
  the retrieval/search request; the `/history` feed surfaces these as `kind: "search"` entries
  (`chatHistoryService.ts:253`, `historyItemPresenter.ts`), so it is not conversation-only.
- Today every one of these emits only **audit log + telemetry/OpenTelemetry** — nothing the
  browser subscribes to.

## The load-bearing constraint

Document and crawl transitions happen in a **separate worker process**, and prod runs **multiple
API instances across two region stacks**. An in-process `EventEmitter` (like today's
`InMemoryPublicConversationEventBus`) can never deliver a worker-originated change to a browser
whose SSE connection is held on an API instance. Any push covering documents/crawl **requires a
cross-process, cross-instance transport.**

Recommended transport: **Postgres `LISTEN/NOTIFY`.** Fits "Postgres is the system of record / do
not add a new storage system," gives cross-process + cross-instance fan-out without adding Redis.
Design constraints: a dedicated listener connection per API instance; 8 KB `NOTIFY` payload cap
(send resource identity + version, never bodies); delivery is **lossy** (dropped if no instance is
LISTENing, e.g. mid-deploy). The AMQP fan-out already in place is worker-oriented and heavier for
browser-facing signals.

## Durability decision (why the bus is intentionally ephemeral)

The question "do the pushes need to be durable?" resolves to **no** — what the product needs is
**convergence**, and convergence is cheaper and more correct than durable delivery:

- **Push frames are content-free invalidation hints**, carrying only resource identity + a
  monotonic `version`. They never carry authoritative state. The client responds by re-reading
  Postgres (the existing `loadDocuments` / `loadCrawlJobs` / `refreshInbox` / `loadHistory`
  functions). The `version` MUST be a real monotonic per-resource value (a row revision counter or
  a commit-ordered event sequence), **not** `updated_at`: `currentTimestamp()` here is `now()`
  (transaction-start time), so `updated_at` is not commit-ordered and two overlapping writers can
  land out of order relative to it. `documents.revision` is a suitable existing source.
- **Convergence is guaranteed by three mechanisms, not by durable delivery:**
  1. **Refetch on (re)connect** — every SSE open/reopen triggers a full refetch of the visible
     slice, catching up everything missed while disconnected.
  2. **Reconcile floor** — a slow background poll (e.g. 30–60s) guarantees eventual convergence
     even if push fails silently end-to-end. Push slows polling; it never removes it.
  3. **Version guard** — used only to **coalesce** a burst of hints, never to suppress the
     trailing refetch. The client always refetches once after the last hint in a burst, so a late
     or out-of-order hint degrades to a redundant fetch (which reads latest committed state), not
     to staleness. Because the guard is a pure optimization over refetch, a version anomaly cannot
     strand the surface; it only affects how many redundant fetches happen.
- **Durability of the underlying facts already lives in Postgres** (documents, crawl_jobs,
  decisions, action outbox). Push must never be the only record of a change.
- **Genuinely must-not-miss, one-shot notifications** (e.g. "your export finished") are a
  *persisted notifications table* queried on load, with push as the live hint — not a durable
  replay log on the bus. That is out of scope here and would be its own feature.

Making the bus itself durable (per-client queues, replay logs, acked delivery) would buy an
expensive property to solve a problem that convergence already solves. Rejected.
