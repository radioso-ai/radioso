# Implementation Plan: Scalable Realtime Dashboard Updates

**Branch**: `1042-scalable-realtime-updates` | **Date**: 2026-08-25 | **Spec**: [spec.md](./spec.md)  
**Input**: Approved feature specification in `specs/1042-scalable-realtime-updates/spec.md`

## Summary

Deliver content-free, workspace-scoped dashboard invalidations as an optional acceleration layer over PostgreSQL-authoritative reads. Backend application services request invalidation only after commit through a bounded, synchronous in-process enqueue port. Hosted deployments publish over Memorystore for Redis Cluster sharded Pub/Sub to an independently scalable Cloud Run realtime gateway; self-hosted deployments use standalone Redis/Valkey or disable realtime and rely on the same 45–60 second visible-query reconciliation floor.

The frontend will adopt TanStack Query only for the covered dashboard reads. One `QueryClient` is created per canonical workspace dashboard session, every key includes the workspace and all result discriminators, and one central invalidation coordinator provides active-query-only mapping, single-flight behavior, and one trailing reconciliation when an event arrives during a fetch. Realtime never becomes a correctness dependency.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 and Next.js 16 App Router  
**Primary Dependencies**: Express, Zod, Pino, `redis` 6.2.1, `@tanstack/react-query` 5.x  
**Storage**: PostgreSQL 16 remains authoritative; Redis/Valkey holds only transient Pub/Sub traffic and expiring admission leases  
**Testing**: Vitest, Supertest, React logic/component tests where appropriate, Playwright, Terraform validation, local CI  
**Target Platform**: Linux containers; hosted GCP Cloud Run plus Memorystore for Redis Cluster; Docker/self-hosted standalone Redis/Valkey or disabled mode  
**Project Type**: TypeScript monorepo web application with API, workers, dedicated realtime runtime, frontend, SDK, docs, and Terraform  
**Performance Goals**: 100,000 fleet-wide open browser streams; 10,000 tenants; 2,000 concurrently active workspaces; no unrelated-connection scan on publish; one pending merged write per blocked connection  
**Constraints**: Cloud Run maximum request concurrency is 1,000 per instance; stream age is jittered strictly below the 15-minute reauthentication bound and platform timeout; visible covered reads always reconcile in 45–60 seconds; mutation latency and success never depend on broker availability  
**Scale/Scope**: Documents, Sources, History, Quality, and Needs Attention visible dashboard reads; all producing API/worker state transitions; hosted and self-hosted runtime/infra/docs; public OpenAPI and SDK stream contract

## Constitution Check

### Pre-design gate

- [x] Spec 1042 exists and was explicitly approved on 2026-08-25.
- [x] Backend functionality is split into tests-first tasks. Production code follows a demonstrated failing test.
- [x] Frontend logic tests cover keys, mapping, cancellation, trailing reconciliation, visibility, and retry policy; Playwright covers user-visible journeys.
- [x] PostgreSQL remains the system of record. No durable product state moves to Redis.
- [x] The broker, producer coalescer, gateway fan-out, stream presenter, admission controller, browser client, and query coordinator have narrow ports and independent ownership.
- [x] `backend/src/app/composition/` owns selection and lifecycle of no-op, standalone Redis, and Redis Cluster implementations.
- [x] Runtime prompts and LLM behavior are unchanged.
- [x] The public endpoint is registered code-first, generated OpenAPI is refreshed, and the TypeScript SDK snapshot is synchronized.
- [x] Document worker, crawl worker, action dispatch, Cloud Tasks, AMQP, connector, and MCP payloads remain backward compatible. Realtime invalidations are an orthogonal post-commit side effect.
- [x] Operator and self-hosted documentation, environment examples, deployment/rollback guidance, and the architecture code map are in scope.
- [x] Observability is designed for every new queue, broker, stream, reconnect, failover, admission, and reconciliation path without sensitive payloads or identifier metric labels.

### Post-design gate

- [x] Broad knowledge points inward: application services know only `WorkspaceInvalidationPublisher`; infrastructure implements it; composition selects implementations.
- [x] The dedicated realtime runtime does not boot migrations, document workers, assistant dependencies, or the full API dependency graph.
- [x] Repositories are not decorated. Publication remains at application-service transaction boundaries where commit success is known.
- [x] Pub/Sub loss, gateway restart, deploy, stream expiry, malformed frames, overload, and hidden-tab transitions all converge on authoritative refetch.
- [x] Per-process producer memory, per-workspace invalidation state, active subscriptions, open streams, and blocked-client state are explicitly bounded.
- [x] The frontend query cache—not the event client—is the sole request-concurrency authority.
- [x] No unresolved clarification remains. Deployment-specific values are typed configuration with safe validation and documented defaults.

## Architecture

```text
API / workers
  PostgreSQL transaction
      |
      +-- rollback ------------------------------> no invalidation
      |
      +-- commit -> WorkspaceInvalidationPublisher.enqueue()
                       | synchronous, bounded, never awaits broker
                       v
                  coalescing producer
                       |
              SPUBLISH / PUBLISH
                       v
          Redis/Valkey workspace channels
                       |
             dynamic gateway interest
                       v
       dedicated realtime Cloud Run service
            | workspace-indexed fan-out
            | one serialized writer/connection
            v
     same-origin exact edge route
      (self-host: exact Next proxy)
            |
       fetch-based SSE browser client
            |
       workspace invalidation coordinator
            |
          TanStack Query
            |
       authoritative backend GETs
            v
          PostgreSQL

Visible queries also poll every 45–60 seconds regardless of stream health.
```

### Mutation flow

1. The owning application service performs its existing PostgreSQL transaction.
2. On rollback or commit failure it publishes nothing.
3. A service that can run inside a caller-owned transaction returns a pure
   `PostCommitInvalidationReceipt` to that caller. The outermost owner flushes
   the receipt only after its transaction promise resolves; persistence code
   never owns the publisher.
4. After commit the owner calls a non-async `enqueue(workspaceId, kinds)` port.
5. The producer merges kinds into a bounded map and schedules work through one process-level scheduler; it never allocates one timer per event or workspace.
6. Capacity exhaustion coalesces an existing workspace entry or drops a new entry, increments aggregate telemetry, and never changes the mutation result.
7. A flush publishes a content-free envelope to the workspace channel at no more than the configured cadence. Broker errors are observed and discarded; the periodic query floor provides correctness.

### Connection flow

1. The browser opens `GET /backend/api/v1/events` with its dashboard session cookie and canonical `X-Workspace-Id` header.
2. Hosted GCP routes that exact path at the external Application Load Balancer,
   rewrites it to `/api/v1/events`, and sends it directly to the realtime
   serverless NEG; ordinary paths still reach the frontend service. The service
   uses `internal-and-cloud-load-balancing` ingress, disables its default URL,
   and permits `allUsers` invocation only because external browser requests at
   the load balancer have no Google identity token; Cloud Armor and mandatory
   application session/workspace authentication protect the route.
3. The gateway performs session-only authentication and rechecks active account membership and workspace ownership. It does not accept a shared workspace API token as a browser-stream credential.
4. After authentication, admission reserves a hard local process slot, then an
   atomic Redis lease enforces account, workspace, and account-principal limits.
   Post-auth reconnect buckets use the same account slot. If distributed
   admission cannot be verified, new streams fail closed with `503` and jittered
   `Retry-After`; Cloud Armor or the self-hosted reverse proxy owns pre-auth
   origin rate limiting.
5. Concurrent first connections await one single-flight workspace subscription.
   The transport subscription is active before the gateway commits HTTP 200 or
   writes `ready`; timeout/failure releases both admission layers and returns
   `503` without a partial SSE response.
6. One writer pump serializes each `ready`, `invalidate`, heartbeat, or `resync`
   frame into one bounded buffer and calls `res.write` once. After backpressure it
   waits for `drain`, retains one merged marker, lets `resync` dominate, coalesces
   heartbeats, and enforces both blocked duration and `res.writableLength`.
7. Redis generation change, reconnect, failover, or slot move marks interests
   reconnecting. New sessions wait; existing sessions receive one dominant
   `resync` after every affected subscription is restored. Duplicate handoff
   delivery is tolerated.
8. Request abort, response close/error/finish, subscribe failure, blocked timeout,
   max age, admission lease loss, prolonged transport loss, and shutdown all call
   one idempotent close that releases connection, interest, lease, timers, and
   listeners.

### Browser/query flow

1. `DashboardQueryProvider` is mounted in `frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx` only after authentication, canonical workspace resolution, and route canonicalization. It wraps `DashboardShell`, including the sidebar and active view.
2. The provider creates one `QueryClient` for that canonical workspace dashboard session and resets it on workspace change. Workspace ID remains present in every key.
3. Shared defaults use `staleTime: 0`, bounded retries excluding abort/401/403, `refetchOnWindowFocus: false`, `refetchOnReconnect: false`, and `refetchIntervalInBackground: false`.
4. One dashboard visibility lifecycle closes the stream and cancels covered workspace GETs while hidden. On visibility, it establishes transport interest, waits for `ready`, then enables/reconciles; a terminal stream outcome immediately enables poll-only reconciliation. A reconnect failure never disables visible polling.
5. Event mappings target only active exact keys. If a query is idle, it is invalidated/refetched. If fetching, one dirty bit is retained by query hash and a single trailing invalidate/refetch runs when the query becomes idle. The coordinator is bounded by active queries, not event volume.
6. Each query uses one dynamic interval: Documents crawl activity retains its 2-second known-active cadence, Sources crawl state retains its 5-second known-active cadence, and all other visible states use deterministic key-derived jitter from 45 to 60 seconds.
7. Needs Attention maintains a latest-set Query result and a separate displayed snapshot that advances only on operator Refresh. Quality freezes the rendered current-page snapshot during close/triage while the cache may continue updating; it never disables the query merely to defer presentation.

## Project Structure

### Feature artifacts

```text
specs/1042-scalable-realtime-updates/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── pr1078-salvage.md
├── contracts/workspace-events.md
├── checklists/requirements.md
└── tasks.md
```

### Source changes

```text
packages/workspace-invalidation-contract/
├── src/index.ts                         # protocol schemas, kinds, ports, helpers
└── tests/

backend/src/modules/realtime/
├── application/                         # bounded producer and fan-out orchestration
├── domain/                              # limits and state machines, no provider knowledge
├── infrastructure/                      # Redis/Valkey transports and admission leases
└── http/                                # auth adapter, SSE presenter, routes, health

backend/src/app/composition/
├── realtimeComposition.ts               # dedicated runtime graph
└── ...                                  # publisher wiring in API/worker graphs

backend/src/realtime.ts                   # dedicated process entrypoint
backend/src/realtimeServer.ts             # small HTTP server/lifecycle surface
backend/tests/{unit,integration,contract}/realtime/

frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx
frontend/app/backend/api/v1/events/route.ts # exact self-host/local stream proxy
frontend/components/providers/dashboard-query-provider.tsx
frontend/lib/dashboard-query-keys.ts
frontend/lib/dashboard-query-invalidation.ts
frontend/lib/workspace-events-client.ts
frontend/lib/workspace-events-provider.tsx
frontend/tests/                           # logic/component coverage
frontend/e2e/                             # visible journey coverage

infra/                                    # Memorystore, networking, IAM, Cloud Run, alerts
typescript-sdk/                           # synchronized generated stream surface
docs/ and docs-portal/content/            # operator and developer guidance
```

**Structure Decision**: A shared package owns the cross-runtime protocol and narrow publisher contract. The backend realtime module owns provider-neutral behavior and provider adapters; composition owns runtime choice. The dedicated gateway has a small entrypoint and graph. The canonical workspace page owns provider lifetime. Existing dashboard views are migrated to shared queries without moving their presentation concerns into the event client.

## Module Ownership & Seams

- **Shared contract**: Knows protocol version, bounded invalidation kinds, frame/envelope validation, and the `WorkspaceInvalidationPublisher` port. It knows no Redis, HTTP, React, or product service.
- **Application services**: Know which invalidation kind follows a successful authoritative transition. Nested transaction work returns a pure post-commit receipt to the outer owner. Services do not know channels, brokers, gateway topology, retries, or browser query keys.
- **Producer**: Knows bounded coalescing, fairness, cadence, and a provider-neutral publish transport. It does not know SQL transactions or frontend surfaces.
- **Redis transports**: Own separate publisher/subscriber clients, one-channel sharded subscribe calls, mandatory error listeners, byte-before-decode validation, topology generations, reconnect, and explicit prefix/channel naming. They do not own coalescing, domain meaning, or browser fan-out.
- **Gateway fan-out**: Knows bounded active local workspace interest, single-flight subscribe/release, exact listeners, transport generations, and connection mailboxes. It does not scan all connections and does not query product data.
- **Admission controller**: Knows process caps, Redis server-time account-slot leases and counters, per-aggregate expected→desired CAS serialization/replay fencing, capped expiry cleanup, post-auth reconnect buckets, renewal/degraded close, and idempotent release. It does not authenticate or render SSE.
- **Session authenticator**: Uses the tiny realtime DB pool and one bounded query/port to validate session, active membership, account, and workspace and return `sessionExpiresAt`. Session `last_seen` touch is throttled/best-effort. It does not reuse full `AuthService` or boot audit, mail, assistant, or API composition.
- **SSE presenter**: Knows HTTP framing, serialized writes, heartbeat, max age, backpressure, and cleanup. It does not subscribe directly to Redis or interpret product records.
- **Hosted edge route**: The load balancer maps and rewrites the exact browser event path to the gateway route, directly targets the realtime NEG, and applies Cloud Armor pre-auth origin throttling. Restricted ingress/default URL policy prevents bypass; application session authentication remains mandatory.
- **Self-hosted exact proxy**: Allows GET only, forwards a header allowlist plus abort signal, strips caller authorization/forwarding/hop-by-hop headers, streams without buffering, and allowlists SSE response headers. It does not modify the ordinary catch-all API proxy or claim to recover a trusted client IP from untrusted headers.
- **Event client**: Knows fetch streaming, frame parsing, terminal outcomes, stable-connection backoff, one auth refresh, and `Retry-After`. It does not fetch dashboard resources.
- **Query registry/coordinator**: Knows semantic query families, active-key event mappings, dirty trailing reconciliation, abort propagation, and polling policy. It does not own UI presentation snapshots.
- **Dashboard views**: Know rendering and mutation interactions. Needs Attention and Quality own their explicit displayed-snapshot policies.
- **Application composition**: Selects no-op, standalone, and Redis Cluster publisher/subscriber/admission implementations; owns startup, readiness, shutdown, and lifecycle ordering.
- **Files kept small**: Existing repositories, `defaultComposition.ts`, `applicationModule.ts`, the catch-all frontend proxy, `DashboardShell`, and view components receive only narrow wiring or extracted helpers.
- **Required refactors**: Extract the stream-safe write presenter, minimal session authentication port, query-key registry, and provider-neutral invalidation publisher before adding transition coverage.

## Query Ownership and Event Mapping

Semantic key families are centralized in `frontend/lib/dashboard-query-keys.ts`:

- `documents.list(workspaceId, { sourceId, page, pageSize })`
- `documents.crawlActivity(workspaceId)`
- `sources.list(workspaceId)`
- `sources.crawlState(workspaceId)`
- `history.slice(workspaceId, { filter, page, pageSize })`
- `quality.stats(workspaceId, { range })`
- `quality.turns(workspaceId, normalizedFiltersAndPage)` with set-like filters sorted
- `attention.decisions(workspaceId)`
- `attention.humanOwned(workspaceId, { pageSize })`

The central registry maps content-free kinds to active families:

| Kind | Active query families |
|---|---|
| `document.status_changed` | exact active `documents.list` variants |
| `crawl.status_changed` | `documents.crawlActivity`, `sources.crawlState`, `sources.list` |
| `crawl.progress` | `documents.crawlActivity` only |
| `hitl.decision_created`, `hitl.decision_resolved` | `attention.decisions` |
| `conversation.ownership_changed` | `attention.humanOwned` and active History all/chat slices |
| `conversation.created`, `conversation.turn_committed` | active History all/chat slices |
| `conversation.contact_delivery_changed` | active History all/contact slices |
| `search.created` | active History all/search slices |
| `quality.feedback_changed`, `quality.triage_changed` | `quality.stats` and all active `quality.turns` variants |
| `ready`, `resync` | every active current-workspace family |

History details, older-message loading, drawer behavior, and the existing conversation tail remain outside this migration.

## Configuration and Capacity Model

Configuration is parsed once with Zod and injected:

- `REALTIME_MODE=disabled|standalone|redis-cluster`
- gateway public path and self-hosted internal URL
- Redis seed/TLS/IAM credential settings and channel prefix
- coalescer total-workspace limit, per-workspace kind limit, flush batch, and cadence
- process, account/tenant, workspace, account-principal, and reconnect limits
- admission lease TTL/renewal, heartbeat, blocked-write budget, and stream-age jitter window
- hosted network-origin protection is Cloud Armor-owned; self-hosted operators configure their trusted reverse proxy, and the application ignores caller forwarding headers
- tiny realtime DB pool size, acquire/statement timeouts, and application name
- rollout mode and tenant allowlist

Initial hosted values are rollout defaults, not substitutes for the acceptance load
tests:

| Setting | Initial value | Required relationship / reason |
|---|---:|---|
| Cloud Run request concurrency | 1,000 | Platform maximum; application cap remains lower |
| `REALTIME_MAX_CONNECTIONS` | 900/instance | Leaves at least 10% request/resource headroom |
| Realtime max instances | 150 | `ceil(100000 / 900 × 1.25) = 139`; rounded up for deploy/reconnect headroom |
| Gateway and edge backend timeout | 1,200s | Explicit on both; greater than maximum stream age plus drain margin |
| Stream age | random 720–840s | Effective expiry is the minimum of this, session expiry minus 30s, and every request timeout minus 30s; always below 15 minutes |
| Heartbeat | 20s | Below all documented proxy/platform idle thresholds |
| Authentication / subscribe timeout | 2s / 3s | No partially committed SSE on dependency delay |
| Short transport-loss grace | 20s | Hold one pending resync; jitter-close earlier if admission lease safety demands it |
| Blocked duration / `writableLength` | 10s / 256KiB | Either limit closes the stream; one pending marker is additional protection |
| Browser frame / broker envelope | 4KiB / 8KiB | Byte cap is enforced before decode; both are below writer budget |
| Local unique workspace interests | 900/instance | Never exceeds local stream cap; fleet replicated-interest load is tested independently |
| Interest release grace | 5s | Absorbs short reconnect churn while guaranteeing cleanup |
| Account / workspace / principal streams | 10,000 / 5,000 / 5 | Principal means one user across the account; all three counters share the account slot |
| Admission TTL / renewal / safety | 90s / 30s ±20% / 20s | Renewal is well below TTL; degraded streams close before expiry with 0–5s jitter |
| Expired aggregates pruned | 128/operation | Constant work; residual backlog rejects new admission and drains through a bounded sweeper |
| Reconnect buckets | principal 12/min burst 4; workspace 2,000/min burst 200; account 5,000/min burst 500 | Post-auth abuse control; all use Redis server time and jittered retry guidance |
| Cloud Armor attempt limit | 1,200/min/source IP | Pre-auth hosted protection; tune from NAT/load data before default-on |
| Producer pending workspaces / batch / concurrency / cadence | 4,096 / 256 / 32 / 100ms | Bounded memory and fairness while staying inside freshness SLO |
| Redis queued commands | 4,096/client | Publisher offline queue disabled; reconnect cannot create an unbounded stale avalanche |
| Realtime PostgreSQL pool | max 1 (allowed 1–2), acquire 2s, statement 2s | Separate `radioso-realtime` application name; at 150 instances the default reserves at most 150 direct connections |
| Shutdown drain | 8s | Completes before Cloud Run's approximate 10-second termination window |
| Browser reconnect | full jitter 1–30s | `Retry-After` wins; reset only after stable ready duration |
| Visible reconcile floor | deterministic 45–60s/key | Never weakened by connection health |

Zod relational validation rejects an application cap at or above platform
concurrency, renewal not safely below TTL, stream age at or above 15 minutes or
either request timeout, heartbeat above the smallest idle budget, frame/envelope
caps above writer/transport budgets, or a gateway DB pool outside the dedicated
small-pool bound. Terraform also validates that realtime max instances multiplied
by the selected pool maximum fits its explicit share of the deployment's
PostgreSQL connection budget; reconnect admission sheds load rather than opening
an unbounded database queue.

The exact 100,000-stream hosted path is browser → Application Load Balancer →
realtime Cloud Run; it does not consume frontend Cloud Run concurrency. The load
profile still measures load-balancer, Cloud Armor, gateway, Redis replicated
workspace-interest, and Postgres authentication capacity. A self-hosted operator
that chooses the exact Next proxy must size that proxy as a second long-connection
tier or route the event path directly at its reverse proxy.

Memorystore shard count, replicas, and node memory/tier are explicit Terraform
inputs rather than a guessed universal default. Deployment preflight checks the
selected cluster's client, throughput, network, CPU/memory, and failover capacity
against the replicated-interest profile. Redis connect/IAM and private-network
reachability are granted to every actual producer runtime—API/backend, document/
worker-task, crawler poller/task, and the Slack-hosting service—plus the gateway,
with no frontend access. Preflight also verifies required APIs and regional/
project quotas for 150 Cloud Run instances, the allocated Postgres connection
share, Redis limits, load balancer/Cloud Armor, and the load-generator/source-IP
topology before a hosted acceptance run begins.

### Health, degraded behavior, and shutdown

- **Startup** validates config and opens the tiny auth DB pool, subscriber client,
  and admission command client before readiness. Publisher clients exist only in
  API/worker producer compositions.
- **Liveness** covers only server/process/event-loop viability; Redis or Postgres
  outage alone does not trigger a fleet restart.
- **Readiness** requires valid config, reachable auth DB, usable admission client,
  base subscriber readiness, and non-draining state. Zero workspace interests do
  not make readiness fail. A per-stream `ready` still waits for that workspace.
- A short Redis continuity break makes readiness false, rejects bounded new
  subscription waits, marks interests reconnecting, and retains one resync for
  existing streams. Recovery restores interests before sending resync.
- A prolonged broker outage or admission-renewal risk jitter-closes affected
  streams before lease expiry. Browsers stay poll-correct; liveness remains true.
- On SIGTERM the runtime marks unready, stops intake, best-effort queues resync/end,
  force-closes within eight seconds, releases local/lease state, unsubscribes and
  closes Redis, closes the small DB pool/telemetry, and exits before SIGKILL. It
  never attempts to drain streams for their normal 12–14 minute lifetime.

## PR1078 Integration Strategy

`pr1078-salvage.md` is the allowlist. No realtime commit is cherry-picked wholesale.

- Cherry-pick only the isolated website-crawler checkpoint coalescing production file and focused unit test from `c46dba4056`.
- Extract only the missing conversations-table migration fixture from `77eb31b0a`.
- Reimplement action-dispatch transition correctness from current `origin/main` with tests; do not transplant its old repository state.
- Port the useful SSE atomic-write intent and client hardening behavior into the new presenter/client boundaries.
- Rewrite publishers, crawl recovery, frontend fetching, gateway deployment, OpenAPI, and SDK work against the approved architecture.
- Discard PostgreSQL LISTEN/NOTIFY, global sequence/version state, repository decorators, awaited publication, main-API stream ownership, per-view custom fetch loops, obsolete specs, and generated snapshots.

## Public Contracts, SDK, MCP, and Queue Review

- Register `GET /api/v1/events` in the code-first OpenAPI document with cookie authentication, `X-Workspace-Id`, SSE response frames, terminal status behavior, and `Retry-After`.
- Regenerate `backend/openapi.yaml` and `backend/openapi.json`; run `typescript-sdk/pnpm run sync`, build, and tests.
- Add a copilot coverage-map exclusion: this is an ambient operator-runtime capability with no meaningful copilot action.
- The MCP retrieval/assistant contract does not change. Document that the stream is a dashboard transport, not an MCP event surface.
- OpenAPI and generated SDK/MCP type snapshots include the route contract for
  drift detection, but the API-token `GeneratedRadiosoClient` gains no stream
  convenience method and MCP gains no tool or event surface. Browser/dashboard
  session-cookie fetch streaming is the only supported client boundary.
- Existing AMQP, Cloud Tasks, crawler, document-worker, action-dispatch, connector, and worker job payloads do not change. Snapshot serialized and parsed payloads, not only TypeScript types, and prove invalidation happens after the existing commit boundary and outside durable job payloads. Producer injection covers API, document worker, worker-task server, crawler poller, crawler-task server, and Slack connector; the realtime gateway is subscriber-only.

## Observability

Use low-cardinality counters, gauges, histograms, structured logs, and OpenTelemetry spans for:

- producer enqueue accepted/coalesced/dropped; flush size/latency/failure; bounded queue saturation
- broker state, reconnect/failover, publish/subscribe failures, active channel interest
- admission accepted/rejected/degraded, lease renewal failure, reconnect throttling
- open/ready/slow/expired/closed streams, writer backlog, heartbeat delay, cleanup reason
- browser attempt/outcome/reconnect/resync/malformed frame and stable-connection duration
- invalidation-driven, ready/resync-driven, known-active, and reconcile-floor fetches
- crawl recovery released row count, affected workspace count, batch count, and `hasMore`
- event-loop lag, memory, connection utilization, gateway readiness, and end-to-end synthetic freshness
- Redis node memory/CPU/client/network saturation and failover, DB pool acquire/
  auth latency, Cloud Run max-instance saturation, interest cleanup baseline,
  and healthy p95/p99 freshness as well as fallback freshness

Workspace, account, principal, resource, and connection IDs may appear only where necessary in access-controlled structured logs/traces and must be hashed or omitted according to existing telemetry policy. They are never metric labels. Prompts, completions, messages, document content, chunks, tokens, cookies, credentials, and connection strings are never emitted.

## Test Strategy

- **Contract/unit**: schemas; bounded coalescing; fairness; no per-event timers; channel naming; Redis modes; session-only auth; distributed leases; trusted proxy parsing; fan-out indexing; subscribe-before-ready; atomic serialization; blocked clients; idempotent cleanup; event parser; retry/backoff; semantic keys; mapping; dirty trailing reconciliation; deterministic jitter; abort handling; presentation snapshots.
- **Integration**: real PostgreSQL transaction commit/rollback seams; real Redis/Valkey standalone Pub/Sub; Redis Cluster sharded Pub/Sub in an opt-in/local CI profile; transport disconnect/reconnect/generation resync; gateway readiness/shutdown; stale crawl `SKIP LOCKED` batches; hosted exact-edge routing and self-hosted exact-proxy streaming; OpenAPI/SDK generation.
- **Playwright**: each covered dashboard surface updates without refresh; hidden/visible transition; poll-only disabled mode; broker/gateway interruption; workspace switch stale-result isolation; overload and authorization terminal behavior; Needs Attention and Quality interaction deferral.
- **Load/soak**: execute the 5,000/s producer profile for 15 minutes plus its
  50,000 one-second burst. Execute the one-hour hosted target through the real
  load balancer and production auth/admission with 100,000 simultaneous streams,
  10,000 tenants, 2,000 workspaces, one cross-gateway workspace, hot traffic,
  slow clients, interest churn, reconnect, Redis failover, and Cloud Run deploy.
  Include a 2.5-active-query-family mix and its 4,167–5,556 GET/s reconcile floor,
  ready/resync load below the 12,000 GET/s budget, a real-browser cohort, and a
  bounded synthetic frontend coordinator profile.
- **Security**: cross-workspace header/session mismatch; revoked membership within 15 minutes; forged forwarding headers; Cloud Run default-URL/ingress bypass attempts; malformed/oversized frames; admission bypass attempts; telemetry redaction.
- **Regression**: full backend/frontend/package/SDK/infra suites plus `pnpm run ci:local -- --all` before PR.

### Hosted acceptance evidence

Default-on is blocked until the real hosted run records all SC-001–SC-014
measurements: live p95 below 2 seconds and p99 below 5 seconds; loss/outage
convergence at most 60 seconds; visibility restoration at most 5 seconds; API
p95 below 1 second with under 1% errors at the required poll/reconnect load;
non-hot p95 degradation no more than 20% while remaining inside freshness SLO;
post-warmup heap drift at most 10%; at most 900 streams per instance; zero queue/
map cap overflow; zero frontend Cloud Run stream requests; interest state back to
baseline within 5 seconds; hot workspace at or below configured 10 frames/second;
and admission/reconciliation/error/close reasons within the recorded budgets.

`specs/1042-scalable-realtime-updates/acceptance/hosted-load-report.md` records the
revision, Terraform inputs, region, quota preflight, Redis sizing, load-generator
and source-IP topology, Cloud Armor preview/tuning, ramp, tenant/workspace/query
mix, achieved instances/concurrency/GET rates, numerical results, memory/queue/
interest baselines, and pass/fail. It contains no credentials, customer IDs, or
raw content.

## Delivery Phases 1–6

Every phase receives an independent Galileo design/diff review before the next phase is accepted. Root owns integration, conflict resolution, commits, and final verification.

1. **Tooling and isolated salvage**: support four-digit Speckit branches with regression tests; commit approved planning artifacts; transplant only the allowlisted crawler and migration-fixture fixes; rebase onto current `origin/main`.
2. **Foundation**: add the shared contract, typed configuration, no-op port, minimal session auth seam, bounded producer, Redis modes, distributed admission interface, and composition/lifecycle skeleton.
3. **Frontend correctness substrate**: add workspace-scoped Query provider, keys, active-only invalidation registry, visibility lifecycle, dirty trailing coordinator, AbortSignal support, and polling-only migrations in the order Documents, Sources, History list, Quality, Needs Attention.
4. **Transport and gateway**: implement sharded/standalone subscriber interest, indexed fan-out, restricted-ingress dedicated runtime, atomic admission leases, atomic SSE presenter, hosted exact-edge routing, self-hosted exact Next routing, health/readiness, shutdown, and resilient browser stream client.
5. **Publishers and recovery**: add post-commit invalidations at all covered API/worker transitions, including explicit receipts across nested assistant/approval transactions; add action-dispatch affected-result correctness and bounded `FOR UPDATE SKIP LOCKED` crawl recovery with immediate aggregate continuation.
6. **End-to-end mapping and operations**: connect live frames to the query coordinator, complete deferred presentation policies, add E2E/load/security/failover tests, Terraform/Docker/config/docs, OpenAPI/SDK, rollout controls, dashboards/alerts, and final local CI.

## Controlled Delegation

- **Codex Luna**: isolated PR1078 salvage, mechanical test inventories, bounded transition publisher slices after ports stabilize, fixtures, and focused regression coverage. Luna must not alter contracts or architecture without root review.
- **Codex Terra**: architecture-heavy shared/backend foundation, Redis/admission/gateway behavior, and complex frontend Query migration slices. Each assignment is bounded to disjoint files and an explicit acceptance test.
- **Galileo**: read-only second opinion on each phase's design before work and each resulting diff before acceptance.
- **Root**: approves interfaces first, assigns slices, prevents overlapping edits, integrates in dependency order, runs cross-cutting tests, performs final senior review, and owns the PR.

## Rollout and Rollback

1. Ship disabled with schema/config/docs and poll-floor behavior.
2. Enable internal workspaces with dedicated gateway and synthetic freshness monitoring.
3. Enable a tenant allowlist while comparing invalidation- and poll-driven freshness and watching admission/broker/stream SLOs.
4. Make hosted realtime default-on only after the recorded 15-minute producer,
   real 100,000-stream, one-hour soak, failover, and revocation gates pass.
5. Rehearse default-on → disabled rollback, then standalone and cluster upgrade/
   failover. Every stage verifies no reconnect loop, no mutation impact, 60-second
   convergence, correct readiness, and clean interest/lease teardown.
6. Rollback sets realtime disabled and removes gateway traffic. Producers become no-op; visible queries continue the 45–60 second floor without a frontend redeploy or contract change.

## Documentation

Before editing documentation, read `docs/document-writer-prompt.md`. Update environment examples, hosted Terraform/deployment guidance, self-hosted Docker guidance, architecture code map/local module briefs, the API/SDK event-stream guide, capacity planning, health/alerts, failure behavior, disabled mode, upgrades, and rollback. Do not regenerate or append feature history to `AGENTS.md`.

## Complexity Tracking

| Deliberate complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| Dedicated realtime runtime | Independent connection scaling, lifecycle, readiness, and deploy isolation | Running streams in the main API couples request capacity, migrations, deploy drain, and the full dependency graph |
| Redis Cluster sharded Pub/Sub | Workspace-routed multi-instance fan-out on the chosen GCP substrate | Google Cloud Pub/Sub distributes one subscription's messages among subscribers and would require per-gateway subscription resources for broadcast |
| Distributed admission leases | Enforce workspace/principal limits across horizontally scaled gateways | Per-process counters cannot bound a hot tenant spread across instances |
| TanStack Query migration | One shared cache/concurrency/cancellation authority for many surfaces | Preserving multiple custom hooks would duplicate polling, stale guards, invalidation, and retry behavior |
| Always-on reconcile floor | At-most-once Pub/Sub can lose an event without a detectable connection failure | Disabling polling on a healthy-looking stream makes silent loss a correctness bug |
