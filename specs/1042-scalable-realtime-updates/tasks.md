# Tasks: Scalable Realtime Dashboard Updates

**Input**: Approved design artifacts in `specs/1042-scalable-realtime-updates/`  
**Tests**: Backend tasks follow red-green TDD. Every production-code task below is preceded by its failing test task. Frontend tests target behavior and state, while visible journeys use Playwright.

## Conventions

- `[P]` means the task can run in parallel because it owns disjoint files and has no incomplete dependency.
- `[US1]` fast visible updates; `[US2]` correctness under delivery failure; `[US3]` isolation and scale; `[US4]` deployment modes.
- Galileo reviews the phase design before work and the phase diff before acceptance.
- Root approves shared interfaces, assigns Luna/Terra disjoint slices, integrates, and commits.
- No task may copy a PR1078 realtime commit wholesale. `pr1078-salvage.md` is the allowlist.

## Phase 1: Tooling, branch baseline, and isolated salvage

**Goal**: Start from current `origin/main`, preserve only independently valuable PR1078 pieces, and leave no old realtime architecture in the branch.

- [X] T001 Add four-digit Speckit branch support in `.specify/scripts/bash/common.sh` and regression coverage in `.specify/scripts/bash/tests/common.test.sh`
- [X] T002 Rebase `1042-scalable-realtime-updates` onto current `origin/main` without applying the archived PR1078 stash
- [X] T003 Record the commit/file salvage allowlist and discard rationale in `specs/1042-scalable-realtime-updates/pr1078-salvage.md`
- [X] T004 Write/port the failing crawler checkpoint coalescing cases from `c46dba4056` into `backend/tests/unit/websiteCrawler/service.test.ts`
- [X] T005 Implement only the reviewed checkpoint coalescing/terminal flush behavior in `backend/src/modules/websiteCrawler/service.ts` and pass T004
- [X] T006 [P] Add the missing current-schema conversations table fixture from `77eb31b0a` to `backend/tests/integration/slack/slack-skill-migration.integration.test.ts` without transplanting unrelated migration code
- [X] T007 Run the focused crawler and Slack migration tests and use `git diff` to prove no PG LISTEN/NOTIFY, sequence migration, repository decorator, or main-API SSE code entered the branch

**Phase 1 gate**: Galileo diff review; root accepts an isolated conventional commit.

---

## Phase 2: Shared contract and backend foundation

**Goal**: Establish provider-neutral, bounded ports and composition seams before any product transition publishes.

- [x] T008 [P] Add failing protocol/schema tests for all version-1 kinds, strict content-free envelopes, browser frames, unknown-kind compatibility, UUID/channel matching, and byte caps in `packages/workspace-invalidation-contract/tests/contract.test.ts`
- [x] T009 Implement the tested Zod schemas, TypeScript types, channel helper, and synchronous `WorkspaceInvalidationPublisher` port in `packages/workspace-invalidation-contract/src/index.ts`
- [x] T010 Wire the new workspace package manifests/build/test exports in `packages/workspace-invalidation-contract/package.json`, `packages/workspace-invalidation-contract/tsconfig.json`, `pnpm-workspace.yaml`, and the root lockfile
- [x] T011 [P] Add failing typed-config tests for disabled, standalone, Redis Cluster, hosted IAM/TLS, the complete capacity table and relational constraints, stream-age, tiny DB pool, rollout, and invalid combinations in `backend/tests/unit/realtime/config.test.ts`
- [x] T012 Implement side-effect-free Zod configuration in `backend/src/modules/realtime/infrastructure/config.ts` and expose environment inputs through `backend/src/app/config/env.ts`
- [x] T013 [P] Add failing producer tests for synchronous enqueue, per-process/per-workspace bounds, kind merging, fair hot-workspace scheduling, one global scheduler, cadence, publish concurrency, shutdown, and aggregate drop/coalesce telemetry in `backend/tests/unit/realtime/bounded-producer.test.ts`
- [x] T014 Implement the provider-neutral bounded producer in `backend/src/modules/realtime/application/boundedInvalidationProducer.ts`
- [x] T015 [P] Add failing port/state-machine tests for publish transport, dynamic subscription interest, indexed fan-out, admission lease handles, and idempotent lifecycle cleanup in `backend/tests/unit/realtime/ports.test.ts`
- [x] T016 Define narrow provider-neutral ports and domain state in `backend/src/modules/realtime/domain/contracts.ts`, `backend/src/modules/realtime/application/workspaceInterestRegistry.ts`, and `backend/src/modules/realtime/domain/realtimeSession.ts`
- [x] T017 [P] Add failing session-authentication tests for one bounded lookup returning `sessionExpiresAt`, active session, account membership, workspace ownership, account switch, expiry, revocation, header mismatch, rejection of workspace API tokens, and throttled/best-effort `last_seen` touch in `backend/tests/unit/realtime/session-authenticator.test.ts`
- [x] T018 Implement the minimum session-only authentication adapter in `backend/src/modules/realtime/http/realtimeSessionAuthenticator.ts` on the tiny realtime DB pool without constructing full `AuthService`, audit, mail, assistant, or API dependencies
- [x] T019 [P] Add failing low-cardinality telemetry/redaction tests for producer, transport, admission, gateway, and stream signals in `backend/tests/unit/realtime/telemetry.test.ts`
- [x] T020 Implement named metrics/log/span helpers in `backend/src/modules/realtime/infrastructure/realtimeTelemetry.ts` without identifier labels or content fields
- [x] T021 Add failing composition tests for no-op publisher selection, startup validation, independent lifecycle ordering, and API/worker mutation availability during broker failure in `backend/tests/unit/realtime/composition.test.ts`
- [x] T022 Implement the no-op/default publisher wiring and lifecycle skeleton in `backend/src/app/composition/realtimePublisherComposition.ts` and inject only the narrow port into applicable API/worker composition graphs
- [x] T023 Update `backend/src/app/composition/README.md` only if the new public composition entrypoint changes its ownership map
- [x] T024 Run package and backend foundation tests plus builds; capture the bounded-memory and mutation-nonblocking invariants in test names rather than comments

**Phase 2 gate**: Galileo interface/diff review; no state-transition publisher work starts until root freezes the shared port.

---

## Phase 3: Frontend correctness substrate in polling-only mode

**Goal**: Replace covered custom fetch schedulers with one workspace-scoped Query authority while realtime is still disabled.

- [x] T025 Add `@tanstack/react-query` to `frontend/package.json` and the root lockfile, with no provider mounted globally
- [x] T026 [P] Add failing key tests for workspace identity, all result discriminators, normalized/sorted set-like filters, and exact-family matching in `frontend/tests/unit/dashboard-query-keys.test.ts`
- [x] T027 Implement semantic key factories in `frontend/lib/dashboard-query-keys.ts`
- [x] T028 [P] Add failing invalidation-coordinator tests for the approved mapping, active-only exact variants, one dirty bit per active query hash, one trailing reconciliation after an in-flight fetch, ready/resync all-active behavior, and burst-bounded work in `frontend/tests/unit/dashboard-query-invalidation.test.ts`
- [x] T029 Implement the central registry/coordinator in `frontend/lib/dashboard-query-invalidation.ts` using QueryCache state transitions and no parallel scheduler
- [x] T030 [P] Add failing provider/visibility tests for one QueryClient per canonical workspace, workspace reset, hidden cancellation, deterministic 45–60 second jitter, terminal poll-only outcomes, subscribe-before-enable ordering, and bounded retry exclusions in `frontend/tests/unit/dashboard-query-provider.test.tsx`
- [x] T031 Implement `frontend/components/providers/dashboard-query-provider.tsx` and mount it around `DashboardShell` after canonical workspace resolution in `frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx`
- [x] T032 [P] Add failing request cancellation tests, including abort-before-refresh, abort-during-refresh, no retry after abort, and AbortError propagation through composed Quality reads, in `frontend/tests/unit/api-abort-signal.test.ts`
- [x] T033 Thread optional `AbortSignal` through covered GET functions in `frontend/lib/api-documents.ts`, `frontend/lib/api-chat.ts`, `frontend/lib/api-quality.ts`, and `frontend/lib/api-hitl.ts`; preserve AbortError in aggregate loaders
- [x] T034 [US1] Add failing Documents state tests for exact list keys, 2-second known-active crawl cadence, 45–60 second idle floor, cancellation, and cached-data preservation in `frontend/tests/unit/documents-query-state.test.tsx`
- [x] T035 [US1] Migrate document list and crawl-activity reads in `frontend/components/dashboard/documents-view.tsx` and focused document children to shared queries; keep mutations authoritative and invalidate through the registry
- [x] T036 [US1] Add failing Sources state tests for separate list/crawl keys, 5-second known-active cadence, idle discovery, and background-failure data preservation in `frontend/tests/unit/document-sources-query-state.test.tsx`
- [x] T037 [US1] Migrate source list and crawl-state reads in `frontend/components/dashboard/document-sources-view.tsx` without sharing Documents' progress wakeups
- [x] T038 [US1] Add failing History list tests for exact workspace/filter/page slices, all/chat/contact/search coverage, cancellation, and unchanged drawer/tail behavior in `frontend/tests/unit/chat-history-query-state.test.tsx`
- [x] T039 [US1] Migrate only History list fetching in `frontend/components/dashboard/history/use-chat-history-state.ts` and `frontend/components/dashboard/chat-history-view.tsx`; leave detail, older-message, drawer, and tail delivery intact
- [x] T040 [US1] Add failing Quality tests for stats/turn key variants, preserved background data, cached updates during a frozen rendered interaction snapshot, success/conflict invalidation, and cancel-unfreeze in `frontend/tests/unit/quality-query-state.test.tsx`
- [x] T041 [US1] Migrate Quality stats/turns reads and interaction deferral in `frontend/components/dashboard/quality-view.tsx` and `frontend/components/dashboard/quality/close-review-popover.tsx` without `enabled:false` invalidation suppression
- [x] T042 [US1] Add failing Needs Attention tests for latest Query results, operator-controlled displayed snapshots, count deltas, Refresh advancement, and rail reuse in `frontend/tests/unit/needs-attention-query-state.test.tsx`
- [x] T043 [US1] Migrate `frontend/components/dashboard/needs-attention-view.tsx` and the rail/badge consumers to the attention queries while keeping displayed-list advancement explicit
- [x] T044 [US2] Add a cross-surface component integration test for workspace switch, filter/page switch, stale-response isolation, one visibility listener, hidden cancellation, and visible convergence in `frontend/tests/unit/dashboard-query-integration.test.tsx`
- [x] T045 Remove only the covered obsolete polling/concurrency hooks after proving no remaining consumers with tests; do not remove unrelated conversation-tail behavior
- [x] T046 Run frontend unit tests, lint, and build with realtime disabled; verify every visible covered read still reconciles in at most 60 seconds

**Phase 3 gate**: Galileo frontend diff review; root verifies polling-only behavior before allowing live events to attach.

---

## Phase 4: Redis transport, admission, and dedicated gateway

**Goal**: Build an independently scalable, restricted-ingress, backpressure-safe transport that can fail without affecting product correctness.

- [x] T047 [P] [US3] Add failing standalone/cluster transport tests for separate publisher/subscriber clients and error listeners, `PUBLISH/SUBSCRIBE`, one-channel-at-a-time `SPUBLISH/SSUBSCRIBE/SUNSUBSCRIBE`, byte-before-decode caps, exact listener cleanup, channel/envelope workspace validation, explicit prefixes, dynamic interest, duplicate delivery tolerance, topology generation, failover/reconnect/slot move, TLS, and async IAM credentials in `backend/tests/unit/realtime/redis-transport.test.ts`
- [x] T048 [US3] Implement version-pinned `redis@6.2.1` standalone and cluster adapters in `backend/src/modules/realtime/infrastructure/redisInvalidationTransport.ts` with new-connection IAM token refresh, bounded command queues, no publisher offline queue, and no reuse of MCP session Redis
- [x] T049 [P] [US3] Add failing distributed admission tests for Redis server time; co-slotted expiry/lease/counter structures; atomic account/workspace/account-principal totals; `(workspace,principal,instance)` local-count aggregates; serialized expected→desired CAS acquire/renew/release; already-desired lost-reply replay; conflicting expected count fencing; duplicate release with local count greater than one; 128-entry expiry cleanup/fail-closed backlog; crash healing; separate reconnect buckets; lease-risk jitter close; and Redis failure in `backend/tests/unit/realtime/redis-admission.test.ts`
- [x] T050 [US3] Implement Lua-backed retry-idempotent CAS admission operations, per-aggregate local serialization, one bounded sweeper/renewal scheduler, and hard local process caps in `backend/src/modules/realtime/infrastructure/redisAdmissionController.ts`; keep pre-auth origin protection outside the gateway admission domain
- [x] T051 [P] [US3] Add failing gateway-registry tests for bounded unique interests, one subscription/listener per local workspace, concurrent first-interest single-flight, last-close-while-subscribing, reconnect cancelling delayed release, workspace-indexed fan-out, no unrelated scan, no ready before subscription, generation resync after continuity loss, duplicate handoff delivery, churn cleanup, and hot-workspace frame caps in `backend/tests/unit/realtime/workspace-gateway.test.ts`
- [x] T052 [US3] Implement the registry/fan-out service in `backend/src/modules/realtime/application/workspaceGateway.ts`
- [x] T053 [P] [US2] Add failing SSE presenter tests for auth/admission/subscribe before HTTP commit; atomic SSE headers with compression disabled; one writer pump and one-buffer/one-write frames; no write before drain after false; heartbeat coalescing; one merged pending marker; resync dominance; `writableLength` and time eviction; effective expiry below session/15-minute/gateway/edge limits; every abort/close/error/finish/dependency/shutdown cleanup path; and idempotent release in `backend/tests/unit/realtime/sse-presenter.test.ts`
- [x] T054 [US2] Implement the provider-neutral stream presenter in `backend/src/modules/realtime/http/ssePresenter.ts`
- [x] T055 [P] [US2] Add failing HTTP contract tests for session-only auth, workspace mismatch, terminal `400/401/403/404`, overload `429/503` with `Retry-After`, cache/buffering headers, and disconnect-during-readiness cleanup in `backend/tests/contract/workspace-events.contract.test.ts`
- [x] T056 [US2] Implement the narrow route/controller in `backend/src/modules/realtime/http/workspaceEventsRoutes.ts` without importing the full API server graph
- [x] T057 [P] [US4] Add failing runtime tests proving no migrations/workers/assistant graph boot; separate tiny auth DB pool/application name; startup/liveness/readiness semantics; zero-interest readiness; admission/broker degraded behavior; bounded subscribe waits; 20-second continuity grace; jitter-close before lease expiry; SIGTERM unready/intake-stop/8-second force-close ordering; and complete resource shutdown in `backend/tests/unit/realtime/runtime.test.ts`
- [x] T058 [US4] Implement `backend/src/app/composition/realtimeComposition.ts`, `backend/src/runtime/startRealtimeRuntime.ts`, `backend/src/realtimeServer.ts`, `backend/src/realtime.ts`, and package/image scripts for the dedicated process
- [x] T059 [P] [US4] Add failing self-hosted exact-proxy tests for GET-only behavior; `Cookie`, `Accept`, workspace, and trace request allowlists; stripping Authorization/serverless/Host/Forwarded/X-Forwarded/hop-by-hop/content-length; never deriving client origin from caller headers; abort propagation; unbuffered body streaming; generic 503; SSE response-header allowlist; and proof the ordinary catch-all proxy is untouched in `frontend/tests/unit/backend-proxy-events.test.ts`
- [x] T060 [US4] Implement local/self-hosted exact proxying in `frontend/app/backend/api/v1/events/route.ts` and `frontend/lib/realtime-upstream.ts`; hosted GCP bypasses this route through its exact load-balancer path rule
- [ ] T061 [P] [US2] Add failing browser-client tests for fetch streaming, fragmented SSE parsing, ready/invalidate/resync, malformed/unknown frames, one auth refresh, terminal poll-only outcomes, `Retry-After`, visibility abort, stable-ready backoff reset, and jittered reconnect in `frontend/tests/unit/workspace-events-client.test.ts`
- [ ] T062 [US2] Implement `frontend/lib/workspace-events-client.ts` as a transport-only client with no resource fetching
- [ ] T063 [US3] Add standalone Redis/Valkey integration coverage for publish, dynamic single-flight subscription, outage generation, recovery-before-resync, bounded admission expiry, degraded close, and shutdown in `backend/tests/integration/realtime/standalone-redis.integration.test.ts`
- [ ] T064 [US3] Add opt-in Redis Cluster sharded Pub/Sub integration coverage for slot distribution, one-channel commands, failover, in-place slot migration, restored delivery plus application resync, duplicate tolerance, IAM reconnect token refresh, and replicated-interest churn in `backend/tests/integration/realtime/redis-cluster.integration.test.ts`
- [ ] T065 [US3] Add load-harness primitives for bounded producer and workspace fan-out distributions in `backend/tests/performance/realtime/` without requiring product DB mutations
- [ ] T066 Run backend/frontend/package focused tests and builds; measure that broker outage adds no awaited work to mutation call sites

**Phase 4 gate**: Galileo gateway diff review; root validates private-runtime and failure-mode boundaries before publisher expansion.

---

## Phase 5: Post-commit publishers and bounded crawl recovery

**Goal**: Cover every approved authoritative transition at application-service commit seams without altering durable queue contracts.

- [ ] T067 [P] [US1] Add failing document-transition tests for import, conditional/unconditional processing status, ready revision, reprocess, deletion, and worker-origin changes; assert enqueue occurs immediately after the authoritative DB promise resolves, before later fallible audit/analytics/dispatch/quota work, and bulk/no-op paths publish once per changed workspace only when affected count is positive in focused tests under `backend/tests/unit/`
- [ ] T068 [US1] Inject the publisher port and enqueue `document.status_changed` at the tested application-service seams under `backend/src/modules/documents/services/`; do not decorate repositories or await broker work
- [ ] T069 [P] [US1] Add failing crawl lifecycle tests for create/delete/pause/resume/source-cancel in `backend/tests/unit/websiteCrawler/jobService.test.ts`, scan/id claim and continuation in worker/repository tests, completion/failure in `worker.test.ts`, and persisted checkpoint progress in `service.test.ts`; conditional no-op repository updates must be silent
- [ ] T070 [US1] Return explicit affected/change results from conditional `updateCheckpoint`, `releasePausedClaim`, `markCompleted`, and `markFailed` methods in `backend/src/db/repositories/websiteCrawlJobRepository.ts`; enqueue `crawl.status_changed` from `backend/src/modules/websiteCrawler/jobService.ts`/worker lifecycle seams and `crawl.progress` only after a true persisted checkpoint in `service.ts`
- [ ] T071 [US2] Add failing PostgreSQL integration tests that select at most `limit+1` stale rows transactionally with `FOR UPDATE SKIP LOCKED`, update only the first `limit`, dedupe/cap workspace IDs, return `{releasedCount, workspaceIds,hasMore}`, avoid overlap across concurrent workers, and publish nothing on rollback in `backend/tests/integration/website-crawl-job-repository.integration.test.ts`
- [ ] T072 [US2] Implement bounded recovery in `backend/src/db/repositories/websiteCrawlJobRepository.ts`; make the crawler poller immediately repeat recovery while `hasMore` even when `claimNext` finds no job, publish once/workspace after each commit, emit aggregate released-row/workspace/batch/hasMore telemetry, and preserve the exact durable crawl payload `{jobId,workspaceId}`
- [ ] T073 [P] [US1] Add failing transaction integration tests for a pure post-commit invalidation receipt from `PostgresAssistantTurnPersistence.completeAssistantTurn`, including direct and caller-owned approval transactions, newly created nested HITL decisions, actual `requestHandoff` ownership change, newly inserted contact actions, rollback, and no-op paths in `backend/tests/integration/chat/postgres-assistant-turn-persistence.integration.test.ts` and approval transaction tests
- [ ] T074 [US1] Carry the pure receipt through `ApprovalDecisionService.resolve` and flush it only after the outer transaction commits; enqueue `hitl.decision_created`, `hitl.decision_resolved`, `conversation.turn_committed`, `conversation.ownership_changed`, and initial contact-action invalidations from the receipt without injecting a publisher into persistence repositories
- [ ] T075 [P] [US1] Add failing History/ownership tests for normal conversation creation, create-once MCP anonymous sessions, create-once Slack links, committed assistant turns, operator replies in `backend/src/modules/handoff/operatorReplyService.ts`, assistant `requestHandoff`, HTTP takeover/transfer/hand-back, and Slack takeover/hand-back including `backend/tests/unit/slack/slack-interactivity-handler-ownership.test.ts`; every result must distinguish changed/created from no-op
- [ ] T076 [US1] Return application-facing `{recordOrLink,created}` results from MCP `getOrCreateByAnonymousSession` and Slack `getOrCreateConversationLink`, plus `changed` ownership results; enqueue `conversation.created`, `conversation.turn_committed`, and `conversation.ownership_changed` only after the owning application transaction commits across API/MCP/Slack/operator-reply seams
- [ ] T077 [P] [US1] Add failing action lifecycle tests for initial `enqueueActions` insert vs `ON CONFLICT DO NOTHING`, visible claim/in-progress, true `markDispatched`, retry/terminal `recordFailure`, and superseded no-ops in action dispatcher/repository tests; add `search.created` commit/no-op tests to the focused `backend/src/modules/documents/services/documentSearchService.ts` service tests
- [ ] T078 [US1] Publish `conversation.contact_delivery_changed` from a product-neutral dispatcher post-persistence outcome callback only after true pending/claim/dispatched/retry/failed transitions, never from `ContactSendActionHandler` success; enqueue `search.created` synchronously after `DocumentSearchService` audit commit, not from read-only `DocumentSearchHistoryService`
- [ ] T079 [P] [US1] Add failing Quality tests for real feedback upsert/clear changes in `backend/tests/integration/answer-feedback-service.integration.test.ts` and triage `updated` vs conflict/not_found in `backend/tests/unit/quality-triage-service.test.ts`, including rollback/no-op silence and ordering before later fallible side effects
- [ ] T080 [US1] Enqueue `quality.feedback_changed` only for a real upsert/clear change and `quality.triage_changed` only for `updated` through the quality/feedback application-service composition seams
- [ ] T081 [US1] Add failing current-main repository tests proving `markDispatched`, `recordFailure`, conditional claim, and `enqueueActions ON CONFLICT DO NOTHING` return true affected/change outcomes only for real transitions, including stale attempts, in `backend/tests/unit/action-dispatcher.test.ts` and `backend/tests/integration/action-request-repository.integration.test.ts`
- [ ] T082 [US1] Reimplement the PR1078 `numUpdatedRows` correctness intent and the additional affected-result contracts against current `origin/main`; do not cherry-pick `9bd5e16e7`
- [ ] T083 [US2] Add an enum-exhaustive publisher coverage audit in `backend/tests/unit/realtime/post-commit-publisher-coverage.test.ts` while retaining real integration tests for every transaction/rollback/no-op seam; the table test may not stand in for commit-boundary proof
- [ ] T084 Prove publisher injection in API, document worker, worker-task server, crawler poller, crawler-task server, and Slack connector runtimes while the realtime gateway remains subscriber-only; snapshot serialized/parser payloads for AMQP and Cloud Tasks (not only TypeScript shapes) to prove exact job compatibility
- [ ] T085 Run all affected backend unit/integration/contract/runtime suites and a producer-saturation mutation test proving every publisher call is synchronous/non-awaited and broker acceptance cannot change mutation latency or outcome

**Phase 5 gate**: Galileo transition/recovery diff review; root verifies every enqueue is post-commit and every rollback/no-op is silent.

---

## Phase 6: End-to-end behavior, deployment, and release gates

**Goal**: Attach live events to the proven Query substrate, validate fleet behavior, and ship reversible hosted/self-hosted operations.

- [ ] T086 [US1] Add failing provider integration tests for frame-to-active-query mapping, ready/resync reconciliation, dirty trailing fetch, terminal poll-only mode, and visibility ordering in `frontend/tests/unit/workspace-events-provider.test.tsx`
- [ ] T087 [US1] Implement `frontend/lib/workspace-events-provider.tsx` and compose it inside `DashboardQueryProvider` without adding another request scheduler
- [ ] T088 [P] [US1] Add Playwright journeys for Documents, Sources, History, Quality, Needs Attention counts, and operator-controlled list snapshots in `frontend/tests/e2e/realtime-dashboard-surfaces.spec.ts`
- [ ] T089 [P] [US2] Add Playwright journeys for disabled mode, silently dropped publication, gateway outage/recovery, hidden/visible, workspace switch, malformed frame, auth terminal outcome, overload retry, and preserved Quality interaction in `frontend/tests/e2e/realtime-fallback.spec.ts`
- [ ] T090 [P] [US3] Complete executable producer acceptance for 5,000 requests/second sustained for 15 minutes plus a 50,000-request one-second burst under uniform 2,000-workspace and 50%-hot-workspace profiles in `backend/tests/performance/realtime/producer-load.test.ts`; assert configured map/queue/concurrency caps, at most 10 frames/second for the hot workspace at 100ms cadence, no mutation wait, and stable producer memory
- [ ] T091 [P] [US3] Build the hosted one-hour acceptance through the real external-LB path with production session auth and Redis admission—never direct gateway/auth bypass—for 100,000 simultaneously open streams, 10,000 tenants, 2,000 active workspaces, one workspace spread across gateways, 50%-hot traffic, worst-case replicated interests, slow clients, churn, reconnect storm, failover, and deploy drain in `tests/performance/realtime/`; include a representative 2.5-active-query-family mix generating the deterministic 45–60s floor (4,167–5,556 authoritative GET/s), ready/resync fan-out capped and measured against a 12,000 GET/s reconciliation budget, a real-browser coordinator cohort plus bounded synthetic frontend-memory profile, and numerical assertions: commit→refetch p95<2s/p99<5s, silent loss/outage<=60s, visibility restore<=5s, API p95<1s with <1% errors, non-hot p95 delta<=20% while retaining freshness SLO, post-warmup heap drift<=10%, <=900 streams/instance, no cap overflow, zero frontend-Cloud-Run stream requests, <=5s interest return to baseline, and configured admission/close-reason budgets
- [ ] T092 [P] [US3] Add security tests for cross-workspace isolation, revoked membership within 15 minutes, forged forwarding headers, default-URL/restricted-ingress bypass, malformed/oversized frames, admission bypass, and telemetry redaction in `backend/tests/integration/realtime/security.integration.test.ts`
- [ ] T093 [US4] Register the endpoint and schemas code-first under `backend/src/app/http/openapi/paths/workspaceEventsPaths.ts` and the OpenAPI registry as dashboard-session-cookie-only SSE with workspace header and `Retry-After`; add generation tests for those semantics and the ambient-runtime copilot coverage-map exclusion in `backend/tests/unit/operatorCopilot/catalogCoverage.ts`
- [ ] T094 [US4] Regenerate `backend/openapi.yaml` and `backend/openapi.json`, run `typescript-sdk/pnpm run sync`, and update generated SDK/MCP OpenAPI type snapshots plus contract/build tests without hand-editing generated files; explicitly assert that no API-token SDK convenience method and no MCP tool/event surface are introduced
- [ ] T095 [P] [US4] Add a dedicated realtime container target and disabled/standalone Redis/Valkey Compose wiring in `infra/` plus `.env.example`, preserving a fully supported no-realtime installation
- [ ] T096 [US4] Add configurable Memorystore Cluster shard count, replica count, and node-memory/tier sizing; validate worst-run max clients, publish/fan-out throughput, network egress, CPU/memory headroom, and failover; provision PSC/TLS/IAM and least-privilege Redis reachability for every producer identity (API/backend, document/worker-task, crawler poller/task, Slack-hosting service) plus gateway; add realtime Cloud Run with `internal-and-cloud-load-balancing` ingress and disabled default URL, `allUsers roles/run.invoker` for external-LB transport plus mandatory app auth, least-privilege runtime identity, serverless NEG/backend, exact rewrite, Cloud Armor, 1,000 concurrency/900 app cap/150 max instances/1,200-second timeouts, one-connection DB pool/fleet budget, probes, Direct VPC, rollout variables, and deploy preflight for required APIs and regional/project Cloud Run, DB, Redis, LB, Cloud Armor, IP/ramp, and load-generator quotas in `infra/terraform/`
- [ ] T097 [US4] Add low-cardinality dashboards, alerts, and synthetic checks for healthy p95/p99 freshness and 60-second fallback; publication drops/failures; Redis memory/CPU/clients/network/failover; DB pool acquire/auth latency; Cloud Run open-stream utilization/max-instance saturation/readiness/event-loop lag; reconnect/resync; queue saturation; writer backlog/slow closes; interest leaks; poll/invalidation reconciliation rates; and end-to-end canary freshness in existing observability/infra ownership areas
- [ ] T098 [US4] After reading `docs/document-writer-prompt.md`, update self-hosted setup, GCP deployment, dashboard browser fetch-stream use, capacity/quota/preflight, health/failure behavior, rollout/rollback, and architecture maps in `readme.md`, `docs/`, and `docs-portal/content/`; state that the endpoint is session-cookie-only and intentionally unsupported by the ordinary API-token SDK and MCP surfaces
- [ ] T099 [US4] Execute and record the full reversible matrix from `specs/1042-scalable-realtime-updates/quickstart.md`: disabled → internal canary → tenant allowlist → default-on → disabled rollback, plus standalone and hosted-cluster upgrade/failover; at every rollback verify no reconnect loop, <=60s convergence, no API mutation outcome/latency impact, health/readiness behavior, and clean interest/lease teardown
- [ ] T100 Execute—not merely compile or leave opt-in—the package, backend, frontend, MCP, SDK, docs-portal, Terraform, Playwright, 15-minute producer, real hosted 100k connection, and one-hour soak acceptance suites; commit a compact `specs/1042-scalable-realtime-updates/acceptance/hosted-load-report.md` recording revision, Terraform inputs, region, quotas/preflight, Memorystore sizing, load-generator/source-IP topology and Cloud Armor preview/tuning, ramp, tenant/workspace/query mix, achieved instances/concurrency/GET rates, numerical SC-001–SC-014 measurements, error/close reasons, heap/queue/interest baselines, and pass/fail without secrets or customer identifiers
- [ ] T101 Run `pnpm run ci:local -- --all`, resolve every failure without weakening tests, and record commands/results for the PR body
- [ ] T102 Obtain final Terra/Luna self-review, Galileo architecture/diff sign-off, root senior code review, and an engineering-manager pass before creating the GitHub PR against `main`

## Dependency Graph

```text
Phase 1 isolated salvage
        |
        v
Phase 2 shared contract + ports + composition
        |
        +--------------------+
        v                    v
Phase 3 Query substrate   Phase 4 transport/gateway
        |                    |
        +----------+---------+
                   v
          Phase 5 publishers/recovery
                   |
                   v
        Phase 6 integration/operations
```

- Phase 3 and most of Phase 4 may proceed in parallel after Phase 2 interfaces are frozen.
- Phase 5 waits for the publisher port and event enum, but individual domain slices are parallel after that point.
- Phase 6 live mapping waits for both Phase 3 and Phase 4. Infra waits for gateway config/health contracts. Generated SDK waits for the code-first OpenAPI source.

## Parallel ownership examples

- Luna can own T004–T007 while Terra owns T008–T024, because the isolated salvage files do not touch the new contract.
- After Phase 2, Terra can own the complex Query substrate/migrations (T025–T046) while Luna takes reviewed mechanical publisher test inventories or transport fixtures that do not overlap.
- In Phase 5, Luna may take disjoint domain publisher pairs only after root supplies the frozen kind/port contract and exact commit seam; Terra retains recovery/transaction or gateway-critical work.
- Root never assigns both agents the same file set and integrates one reviewed commit at a time.

## Definition of Done

- All 38 functional requirements and 14 success criteria have a test, operational proof, or documented rationale.
- Realtime failure never changes authoritative mutation success and never extends visible staleness beyond the poll-floor target.
- No cross-workspace delivery, content-bearing frame, unbounded queue/map/timer, or high-cardinality metric remains.
- Hosted 100,000-connection capacity is demonstrated horizontally within configured Cloud Run concurrency headroom.
- Disabled, standalone, and hosted-cluster modes are documented and smoke-tested.
- OpenAPI, SDK, MCP snapshot, queue compatibility, copilot coverage, docs, local CI, and review gates pass.
