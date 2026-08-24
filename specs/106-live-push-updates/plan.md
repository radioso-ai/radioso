# Implementation Plan: Live push updates for operator surfaces

**Spec**: `106-live-push-updates` · **Branch**: `live-updates-push-mechanism` · **Status**: Approved for implementation
**Inputs**: `spec.md` (normative), `research.md` (current-state map)

## Design discipline answers

- **What does each part know?**
  - `PushEvent` + `WorkspaceEventBus` port (`backend/src/shared/events/`): knows only the frame
    shape `{resourceType, resourceId, workspaceId, changeKind, version}` and pub/sub. Knows
    nothing about documents, crawl, HITL, SSE, or Postgres.
  - `PostgresWorkspaceEventBus` (`backend/src/shared/infra/`): knows `pg_notify`/`LISTEN` and the
    frame codec. Knows nothing about domains or HTTP.
  - Push SSE route/presenter (`backend/src/app/http/`): knows auth + SSE framing + the bus port.
    Knows nothing about domain semantics (FR-008).
  - Publish wiring (`backend/src/app/composition/`): the ONLY place that knows both the domain
    transition points and the bus. Domains stay ignorant of push.
  - Frontend provider (`frontend/lib/workspace-events*`): knows the frame shape, reconnect, and
    coalescing. Surfaces know only "refetch when my changeKinds fire".
- **Ports**: `WorkspaceEventBus` = `publish(PushEvent)` + `subscribe(workspaceId): AsyncIterable<PushEvent>`
  (+ close). Frontend port: `subscribeWorkspaceEvents(changeKinds, onInvalidate, onReconnect)`.
  Narrow per consumer; no fat interface.
- **Dependency direction**: domains ← shared/events (port). Composition depends on both and
  assembles. Infra impl depends on the port + `Database`. Never the reverse.

## Key decisions (resolved)

1. **Version source = one shared Postgres sequence.** Migration `147_workspace_push_version_seq.sql`
   creates `workspace_push_version_seq`; the publish statement assigns
   `version = nextval('workspace_push_version_seq')` inside the same statement as `pg_notify`, so
   versions are monotonic in publish order for every resource uniformly (spec Key Entities allows
   "a shared event sequence added"). `updated_at` is never used. The client guard only coalesces
   and always does a trailing refetch (FR-004), so assignment-order vs commit-order races degrade
   to a redundant fetch.
2. **Transport = Postgres `LISTEN/NOTIFY`**, channel `workspace_push_events`. Mutation paths
   enqueue into a bounded, best-effort publisher that coalesces by `(workspaceId, changeKind)`
   and flushes each burst with one set-based SQL statement; they do not await a separate
   shared-pool query per transition. Subscribe uses a **dedicated
   `pg.Client`** (never the pool — pooled clients
   are recycled), created via a new seam on `Database`
   (`backend/src/shared/infra/database.ts` is already on the `checkNoRawSql` allowlist;
   `backend/scripts/checkNoRawSql.mjs:18-34`), with auto-reconnect + backoff and teardown wired
   into the runtime shutdown paths (`startWorkerRuntime.ts:43-60`, `startCrawlerWorkerRuntime.ts:37-55`,
   API server shutdown). Payloads are identity-only, far under the 8 KB NOTIFY cap.
3. **One bus instance per process, wired in `buildDependencies`.** All three runtimes (API,
   document worker, crawler worker) reuse `buildDependencies`
   (`backend/src/runtime/startWorkerRuntime.ts:27-38`, `startCrawlerWorkerRuntime.ts:28-33`), so a
   single wiring point at `backend/src/app/server/dependencies.ts` (pattern precedent:
   `InMemoryPublicConversationEventBus` at `dependencies.ts:55`) covers worker-origin publishes.
   Tests use the in-memory impl.
4. **Publishes live in composition, not domains.** Composition-level decorators wrap the
   repositories built in `backend/src/app/server/builders/infra.ts:156-184` (documents, crawl,
   conversation, ownership, actionRequest, pending decisions); service-level publish only where
   the repo seam lacks workspace context or the write is service-owned (quality feedback/triage,
   `document.search` audit). `websiteCrawlJobRepository.updateCheckpoint(jobId, checkpoint)` gains
   a `workspaceId` argument (callers hold the claimed job record) so the decorator can publish
   `crawl.progress` without a lookup.
5. **SSE endpoint** `GET /api/v1/events` guarded by `requireWorkspaceSession`
   (`backend/src/app/http/middleware/requireWorkspaceSession.ts` — bearer-capable; the dashboard
   consumes SSE via fetch+reader with an Authorization header, never `EventSource`:
   `frontend/lib/api-chat-stream.ts:39`). Behavior mirrors the public events endpoint
   (`publicChatRoutes.ts:754`): `ready` frame, 25 s heartbeat comment, cleanup on close. The
   generic "async iterable → SSE frames" writer is extracted from
   `chatPresenter.ts` `sendChatSse` (:66) into a shared presenter helper; chat keeps its typed
   wrapper (FR-001).
6. **OpenAPI contract is already registered.** The dashboard route is present in the code-first
   OpenAPI output and generated SDK snapshots. This robustness amendment does not change its wire
   shape, so no regeneration is required unless the endpoint contract itself changes.
7. **Kill switch**: env `WORKSPACE_PUSH_ENABLED` (booleanish, default `true`,
   `backend/src/app/config/env.ts`). Off → endpoint returns 404 and the bus is a no-op publisher;
   surfaces converge on their poll floors alone (SC-002).
8. **Frontend owner = dashboard shell.** A `WorkspaceEventsProvider` mounted in
   `frontend/components/dashboard/dashboard-shell.tsx` (dashboard-only; no SSE on auth/marketing
   pages), keyed on `activeWorkspaceId` from `frontend/lib/workspace-context.tsx:56` — switch
   workspace ⇒ reconnect. Client transport in `frontend/lib/api-events.ts` reuses
   `parseSseEvent` + fetch-with-bearer (`frontend/lib/api-client.ts` `requireWorkspaceApiToken`),
   auto-reconnect with exponential backoff + jitter.
9. **Coalescing** (FR-004): each subscription uses a fixed maximum refresh window (~300 ms), not a
   resettable trailing debounce. The pending timer is the bounded dirty marker, so duplicate hints
   require no retained version set; sustained traffic still produces one refetch per window.
10. **Reconcile floors** (FR-006): documents + crawl polls go 2 s → 45 s and become
    **unconditional while the view is mounted** (removes the known un-arm gating trap,
    `documents-view.tsx:353-389`); inbox badge 30 s → 60 s (`use-inbox-count.ts:17`);
    needs-attention 15/30 s → 60 s (`use-needs-attention-activity.ts:43-44`); history gains a 60 s
    floor while visible (today load-once, `use-chat-history-state.ts:239-242`). Floors are never
    removed.

## Observability (FR-012)

Pino logs, low cardinality, no content: SSE connection opened/closed (workspaceId, connection
count), listener client connect/reconnect/error, publish failure (warn, resourceType + changeKind
only), bus no-op when disabled (once at startup). Client-side: reconnect attempts logged to
console.debug only. No new high-cardinality metrics.

## Robustness hardening amendment

- **Transaction visibility:** composition publishes only from post-commit seams. Rollbacks and
  no-op conditional updates do not emit.
- **Bounded publication:** mutation paths enqueue without an additional awaited SQL query. The
  publisher has a hard queue bound, coalesces redundant workspace/change-kind hints, and flushes
  a coalesced burst in one SQL statement; dropped hints are safe because reconnect and reconcile
  polling remain authoritative.
- **Workspace-proportional fan-out:** local subscribers are indexed by workspace rather than
  scanned globally. Bulk recovery returns only publication identity and never creates an
  unbounded `Promise.all` fan-out.
- **Bounded SSE:** writers respect Node response backpressure. Listener loss closes current
  iterators so browsers reconnect and reconcile; shutdown closes the bus/streams before awaiting
  the HTTP server.
- **Bounded frontend work:** fixed-window invalidation cannot starve under sustained traffic;
  reconnect listeners are always removed; history/document refetches are single-flight with a
  queued trailing rerun and stale-response guards.
- **Quiet telemetry:** lifecycle, failure, drop, and reconnect signals remain observable, but
  routine per-frame delivery is not emitted as an info log.
- **Contract and queue review:** there is no payload or OpenAPI shape change and no AMQP payload,
  retry, or worker-dispatch contract change. The hardening stays inside the existing push port.

### Capacity boundary

The bounded/coalesced adapter prevents overload from becoming unbounded application memory or
request latency, but PostgreSQL still broadcasts every notification to every listening API
process. This design therefore degrades safely rather than claiming unlimited transport
throughput. Before fleet-wide notification traffic approaches PostgreSQL's measured capacity,
replace only the `WorkspaceEventBus` adapter with a partitioned broker; publishers, SSE framing,
and frontend convergence semantics remain unchanged.

## Slices & delivery

The original slices were sequenced. This hardening pass may run backend and frontend work in
parallel because their production/test file sets are disjoint; shared feature artifacts remain
owned by the coordinating agent.

### Slice A — Contract, bus, transport, channel (backend) — **codex terra**

TDD: write failing tests first.

1. `backend/src/shared/events/workspaceEventBus.ts`: `PushEvent` (zod schema + type; exactly the
   five identity fields), `changeKind` enum (all kinds from the spec coverage map),
   `WorkspaceEventBus` port, `InMemoryWorkspaceEventBus`.
2. Migration `147_workspace_push_version_seq.sql` + `backend/src/db/schema.sql` dump refresh
   (`backend/scripts/dump-schema.sh`).
3. `PostgresWorkspaceEventBus` in `backend/src/shared/infra/postgresWorkspaceEventBus.ts` +
   listener-client seam on `Database`; reconnect/backoff; shutdown hooks in both worker runtimes
   and the API server.
4. Env flag `WORKSPACE_PUSH_ENABLED`; wiring in `dependencies.ts` (+ `AppDependencies` type,
   `types.ts:118` area).
5. Generic SSE presenter extraction (`sendChatSse` → shared writer; chat behavior unchanged).
6. `GET /api/v1/events` route (mount in `routes/index.ts:59-102`): auth, `ready`, heartbeat,
   workspace-filtered subscribe, close handling.
7. Publish decorators for **documents + crawl** (the worker-origin P1 surfaces, establishing the
   composition-decorator pattern): `documentRepository.setStatus` / `setStatusIfRevisionMatches`
   (`documentRepository.ts:751/775`) → `document.status_changed`;
   `chunkRepository.publishForDocumentRevision` (ready flip) → `document.status_changed`;
   `websiteCrawlJobRepository` `create`/`claimNext`/`claimById`/`pauseBySourceId`/
   `resumePausedBySourceId`/`releaseTimedOutClaim`/`releaseAllTimedOutClaims`/`releasePausedClaim`/
   `markCompleted`/`markFailed` → `crawl.status_changed`; `updateCheckpoint` (+workspaceId arg) →
   `crawl.progress`.
8. Tests: unit (in-memory bus; frame schema contract = SC-003 no-content test); integration
   (Postgres bus round-trip; **workspace isolation** = SC-004; decorator publishes on document +
   crawl repo transitions — mirror `document-repository.integration.test.ts`); contract (SSE
   endpoint — mirror `public-chat.contract.test.ts:723-744`).

### Slice B — Publish-site sweep, API-process + contact delivery — **codex luna** (pattern replication)

Replicate the Slice-A decorator/service-publish pattern for each remaining FR-007 site, with a
focused test per site asserting the publish fires with the right changeKind:

- `conversationRepository` create + `touch` (called from `chatTurnLifecycle.ts`) →
  `conversation.created` / `conversation.updated`. NOT `publishMessageCreated`.
- `conversationOwnershipRepository.requestHandoff`/`takeOver`/`transfer`/`handBack` →
  `conversation.ownership_changed`.
- `actionRequestRepository.claimPending`/`markDispatched`/`recordFailure` →
  `conversation.contact_delivery_changed` (publish only when rows actually transitioned; the drain
  polls every 5 s and must not spam empty claims).
- `pending_decisions` create/resolve → `hitl.decision_created` / `hitl.decision_resolved`.
- `answerFeedbackService.ts` writes → `quality.feedback_changed`; `quality/triageStore.ts` writes
  → `quality.triage_changed` (service-level).
- `document.search` audit write on the retrieval/search request path → `search.created`
  (service-level).

### Slice C — Frontend transport + provider + documents surface — **codex terra**

1. `frontend/lib/api-events.ts` (fetch+reader SSE client, reconnect/backoff, typed frames).
2. `WorkspaceEventsProvider` + `useWorkspaceEvents(changeKinds, onInvalidate)` hook with
   coalescing + reconnect-refetch signal; mounted in `dashboard-shell.tsx`.
3. Adopt in `documents-view.tsx`: hints → `loadDocuments`/`loadCrawlJobs`; polls → unconditional
   45 s floor.
4. Frontend unit tests (fake timers; mirror `frontend/tests/unit/use-inbox-count.test.tsx`):
   provider dispatch, coalescing (burst → one trailing refetch), reconnect → refetch, workspace
   switch → resubscribe. No markup/CSS assertions.

### Slice D — Remaining surfaces — **codex terra**

- Needs-attention count (`use-needs-attention-activity.ts`): subscribe `hitl.*`,
  `conversation.ownership_changed`, `quality.*` → prompt count refresh; keep "Refresh (N)" pull
  model (FR-011); floor 60 s.
- Rail/inbox badge (`use-inbox-count.ts`): same kinds; floor 60 s.
- History (`use-chat-history-state.ts`): subscribe `conversation.created`/`conversation.updated`/
  `search.created` → refetch current (filter, page) slice; add 60 s floor while visible.
- Hook unit tests for each.

### Slice E — Verification (me, not Codex)

- `pnpm run ci:local -- origin/main` (never delegated to Codex — build/hang trap).
- Review the full diff against spec FRs; confirm SC-001..SC-005 coverage; confirm no docs-portal
  impact (internal channel; note in PR body per decision 6).

## Out of scope (per spec)

Durable delivery, notifications inbox, Redis/Kafka, needs-attention auto-inject, rich payloads,
usage/trends/outbox/directive surfaces (poll-only rows in the coverage map), widget-bus migration
(opportunistic later).
