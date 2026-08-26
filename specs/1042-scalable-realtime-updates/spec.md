# Feature Specification: Scalable realtime workspace updates

**Feature Branch**: `1042-scalable-realtime-updates`  
**Created**: 2026-08-25  
**Status**: Approved  
**Input**: Rebuild the useful behavior from PR #1078 as a production-grade live-update system for thousands of tenants, with bounded fan-out, predictable degradation, and a clean frontend server-state model.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See operator surfaces update without refreshing (Priority: P1)

As an operator monitoring a workspace, I want document processing, crawl activity, quality work, conversations, inbox counts, and needs-attention signals to update automatically so that I can act on current state without repeatedly refreshing the page.

**Why this priority**: The affected state changes in API and worker processes and is currently easy to miss. Live invalidation removes stale operator decisions while retaining authoritative reads.

**Independent Test**: Open the same workspace in two independent browser contexts, perform a covered mutation in one context or a worker, and verify the other context converges without manual refresh.

**Acceptance Scenarios**:

1. **Given** the Documents view is visible, **When** a document transitions through processing states, **Then** its visible state converges within the live-update latency objective without manual refresh.
2. **Given** a crawl is created, claimed, paused, resumed, released, completed, or failed elsewhere, **When** Sources or Documents is visible, **Then** the relevant query family is reconciled without requiring the view to have known about the crawl at mount time.
3. **Given** the Quality queue is visible, **When** feedback or triage changes elsewhere, **Then** its rollup and current page reconcile in the background without replacing the displayed rows with a spinner or error state.
4. **Given** History is visible, **When** a conversation or document-search activity entry changes the active slice, **Then** only the active workspace/filter/page slice is reconciled.
5. **Given** Needs Attention is visible, **When** a new matching item arrives, **Then** the new-item count updates while the operator-controlled displayed list remains unchanged until the operator refreshes it.

---

### User Story 2 - Remain correct when realtime delivery fails (Priority: P1)

As an operator, I want every covered surface to recover from dropped messages, disconnects, deployments, and broker outages so that realtime acceleration can never leave my workspace permanently stale.

**Why this priority**: Live delivery is intentionally transient. Correctness must come from authoritative reads and deterministic reconciliation, not optimistic assumptions about message delivery.

**Independent Test**: Disable the realtime transport, perform covered changes, and verify visible surfaces converge through degraded polling; restore transport and verify reconnect reconciliation catches up without duplicate or cross-workspace data.

**Acceptance Scenarios**:

1. **Given** a live stream reconnects, **When** the server declares it ready, **Then** every currently observed query family for that workspace is reconciled once.
2. **Given** delivery continuity is lost, **When** the client receives a resynchronization signal or reconnects, **Then** it performs authoritative reads rather than attempting event replay.
3. **Given** the realtime transport is unavailable, **When** state changes, **Then** visible surfaces converge within the degraded-mode objective and mutation success is unaffected.
4. **Given** a tab is hidden, **When** state changes, **Then** it performs no realtime or poll work while hidden and reconciles promptly after becoming visible.
5. **Given** a user switches from workspace A to workspace B while a read is in flight, **When** the old read completes, **Then** it cannot update workspace B state or UI.

---

### User Story 3 - Isolate tenants and bound noisy-neighbor impact (Priority: P1)

As a platform operator, I want live updates to scale horizontally with explicit per-tenant limits so that a hot workspace, slow browser, or event burst cannot exhaust shared database, broker, API, or gateway capacity.

**Why this priority**: Multi-tenant fan-out fails operationally when work grows with global tenants, retained event history, or unbounded client queues.

**Independent Test**: Run the defined fleet, burst, hot-tenant, slow-client, and soak workloads and verify bounded memory, request concurrency, event rates, and strict workspace isolation.

**Acceptance Scenarios**:

1. **Given** a workspace emits a sustained burst, **When** invalidations are produced, **Then** redundant kinds are coalesced and the workspace cannot exceed its configured publication or stream-frame rate.
2. **Given** a browser stops reading, **When** additional invalidations arrive, **Then** the server retains only bounded convergence state and eventually closes the slow stream.
3. **Given** a subscriber is authorized for workspace A, **When** workspace B changes, **Then** no B event or identifier is delivered to that subscriber.
4. **Given** transport backpressure or outage, **When** a product mutation commits, **Then** the mutation does not wait for transport recovery and the failed acceleration is observable.
5. **Given** many tenants reconnect after a deployment, **When** streams reopen, **Then** reconnect and reconciliation work is jittered and remains within configured gateway and API budgets.

---

### User Story 4 - Operate hosted and self-hosted deployments predictably (Priority: P2)

As a Radioso operator, I want an explicit realtime-enabled deployment mode and a fully supported polling-only mode so that hosted and self-hosted installations have clear requirements and degradation behavior.

**Why this priority**: Radioso is self-hosted as well as operated on GCP. Realtime cannot silently depend on a cloud-only service or pretend a single-process adapter is production-safe.

**Independent Test**: Start the product with realtime enabled against a compatible transient broker, then start it with realtime disabled and verify both modes pass their documented health and user-convergence checks.

**Acceptance Scenarios**:

1. **Given** realtime is configured, **When** the gateway starts, **Then** readiness fails clearly until its transport and required authentication configuration are usable.
2. **Given** realtime is disabled, **When** the dashboard loads, **Then** no client reconnect loop is created and covered surfaces use their documented reconcile floors.
3. **Given** a transport failover interrupts subscriptions, **When** connectivity returns, **Then** gateways resubscribe, clients reconcile, and no durable message history is required.

### Edge Cases

- A mutation commits immediately before its process exits and its invalidation is lost.
- A transport failover or silent at-most-once loss drops acknowledged transient publications while the connection still appears healthy.
- Multiple invalidation kinds arrive continuously for one workspace.
- The same workspace has connections spread across many gateway instances.
- A workspace has no connected browser when an invalidation is published.
- A browser disconnects before subscription readiness completes.
- Heartbeats and invalidations become writable at the same moment after socket backpressure.
- A stream reaches its maximum age while an event is pending.
- The hosting platform reaches its per-instance connection concurrency or request-timeout boundary.
- Authentication or workspace membership changes during a long-lived stream.
- A terminal authorization or disabled response must not trigger a tight reconnect loop.
- A query is invalidated repeatedly while its prior request is still running.
- A Quality review interaction temporarily prevents row replacement.
- A bulk stale-crawl recovery finds far more jobs than one bounded batch.
- Many recovered crawl jobs belong to the same workspace.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this specification is explicitly approved.
- Backend development MUST follow red-green-refactor with tests written and observed failing before production code.
- Runtime configuration and credentials MUST use environment configuration, update `.env.example`, and never enter logs or metrics.
- Customer data and tenant identity MUST be protected through least privilege, secure transport, and strict workspace authorization.
- Public contract changes MUST use the code-first OpenAPI registry, regenerate checked-in OpenAPI outputs, and synchronize the TypeScript SDK and MCP snapshots.
- The plan MUST review worker and message-queue contracts; existing document, crawl, and action job payloads are expected to remain unchanged.
- Operator-facing setup, failure behavior, and deployment requirements MUST be documented in the same delivery.
- Frontend user-visible journeys MUST prefer Playwright; unit tests MUST focus on query mapping, state transitions, API adapters, parsing, and cancellation rather than presentation markup.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Domain application services own the decision that committed state invalidates a workspace read model; a narrow publisher port owns transient publication; the realtime runtime owns subscriptions and browser streams; frontend query-cache integration owns mapping invalidation kinds to observed reads.
- **Encapsulation Rule**: HTTP routes authenticate and present streams but do not choose domain events; persistence adapters do not publish hidden side effects; application composition assembles adapters but owns no product rules; frontend views do not implement independent request-concurrency policies.
- **New Seams Required**: Introduce a workspace invalidation contract, bounded producer coalescer, transient transport adapter, independently scalable realtime runtime, workspace-local fan-out hub, and centralized frontend query-key/invalidation registry.
- **Anti-Goals**: Do not retain PostgreSQL broadcast, repository proxy decorators, global resource sequences, durable replay, per-client event history, content-bearing frames, transport-specific domain logic, or parallel custom frontend refresh abstractions.
- **Dependency Direction**: Concrete transport and runtime implementations depend on the shared invalidation contract; domain modules depend only on the publisher port; the shared contract must not depend on application composition, HTTP, persistence, or frontend surface definitions.
- **Runtime Wiring**: Default adapters and lifecycle belong in `backend/src/app/composition/`; the dedicated realtime entry point may reuse the backend image but must scale and shut down independently from request-serving API workers.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose one authenticated, workspace-scoped live event stream per visible dashboard session through a stable authenticated public event path.
- **FR-002**: The event protocol MUST support versioned `ready`, `invalidate`, and `resync` control semantics.
- **FR-003**: A browser invalidation MUST carry no more than protocol metadata and one or more bounded invalidation kinds; workspace identity MAY be omitted because the authenticated stream already supplies that scope. Neither browser nor transport frames may carry prompts, completions, messages, document content, retrieved chunks, credentials, tokens, cookies, or connection strings.
- **FR-004**: Delivery order, durable replay, exactly-once handling, and global resource versions MUST NOT be prerequisites for correctness.
- **FR-005**: The client MUST respond to invalidation by marking matching workspace query families stale and reconciling active observers from authoritative APIs.
- **FR-006**: On initial readiness, reconnect, or resynchronization, the client MUST reconcile all currently observed query families for the authenticated workspace.
- **FR-007**: Every covered state transition MUST request publication only after its authoritative transaction commits; rollback MUST publish nothing.
- **FR-008**: The post-commit application path MUST make a non-blocking best-effort enqueue. A full or unavailable local queue MUST drop or coalesce with aggregate telemetry, MUST NOT await broker acceptance, and MUST NOT change the product mutation outcome.
- **FR-009**: Producer buffering and coalescing MUST be globally bounded per process, bounded per workspace, and driven by a bounded number of schedulers rather than one timer per event or tenant.
- **FR-010**: Repeated invalidations for a workspace MUST merge their kinds and produce no more than the configured maximum publication cadence.
- **FR-011**: A gateway MUST subscribe only to workspace channels needed by its active local connections and MUST release unused interest within a bounded time after the final local connection closes.
- **FR-012**: Gateway fan-out MUST be indexed by workspace and MUST NOT scan unrelated connections for each invalidation.
- **FR-013**: Each browser connection MUST retain no more than one pending merged invalidation or resynchronization marker while blocked.
- **FR-014**: Heartbeats and event frames MUST share one serialized writer so partial frames cannot interleave.
- **FR-015**: A connection blocked beyond its configured time or buffer budget MUST be closed and allowed to reconnect and reconcile.
- **FR-016**: Connection admission, invalidation flushes, and reconnects MUST enforce configurable tenant, principal, and process limits plus abuse protection without creating high-cardinality metrics. Capacity settings MUST have a zero-incremental-infrastructure disabled profile, an economical small hosted profile for 2–5 tenants, and an explicit pre-scale profile; the implementation plan MUST choose any account or network-origin dimensions and document trusted-proxy handling from the threat and capacity model.
- **FR-017**: Stream lifetimes MUST be jittered below the hosting platform's request-timeout boundary and the authenticated session expiry. Every stream MUST reauthenticate within 15 minutes so membership or access revocation takes effect within a bounded time. Capacity planning MUST respect the platform's per-instance connection-concurrency limit rather than assuming an unbounded socket count per instance.
- **FR-018**: Hidden tabs MUST suspend the live connection and ordinary polling; visibility restoration MUST reconnect and reconcile once.
- **FR-019**: All affected frontend query keys MUST include workspace identity and every filter/page discriminator that changes the authoritative result.
- **FR-020**: Query cancellation and stale-result isolation MUST prevent a response for an abandoned workspace, filter, or page from updating the active view.
- **FR-021**: Duplicate invalidations for one query key MUST produce bounded request work, a stale response MUST NOT commit into the active slice, and continuous invalidations MUST NOT starve a required trailing reconciliation; the shared query cache remains the sole frontend request-concurrency authority.
- **FR-022**: Every covered visible query MUST retain an always-on jittered reconcile floor between 45 and 60 seconds, even while live delivery appears healthy, because silent at-most-once loss cannot be inferred from connection health.
- **FR-023**: Realtime connection health MAY accelerate reconciliation but MUST NOT weaken, delay, or disable the visible-query reconcile floor.
- **FR-024**: Needs Attention MUST update its new-item count without automatically replacing the operator-controlled displayed list.
- **FR-025**: Quality and Sources MUST preserve displayed data during background refetch failure and MUST not disrupt an active operator interaction.
- **FR-026**: History MUST invalidate only the current workspace/filter/page slice and MUST preserve its conversation, contact-delivery, and search coverage; the existing conversation drawer and tail live behavior MUST remain unchanged.
- **FR-027**: Documents and Sources MUST discover externally started crawl and document transitions without requiring a known-active item at mount time. The reconcile floor MUST also discover Quality rows created by new turns or signals without feedback or triage, and Sources document-count or last-synced drift caused by ordinary uploads or deletes, within 60 seconds.
- **FR-028**: Stale crawl recovery MUST mutate at most a configured bounded batch per transaction, return a distinct bounded set of affected workspaces, and publish at most one crawl-status invalidation per affected workspace per batch.
- **FR-029**: Stale crawl recovery MUST expose whether more bounded work remains, continue through the existing worker flow, and record aggregate released counts without retaining or logging full job identity lists.
- **FR-030**: Realtime-disabled mode MUST be fully supported, documented, and free of tight client reconnect attempts.
- **FR-031**: Realtime-enabled startup MUST validate required transport configuration for the selected standalone or clustered mode and expose health/readiness independently from the main API runtime. Disabled mode MUST require no broker configuration or broker resources.
- **FR-032**: Observability MUST cover accepted, coalesced, dropped, and failed publications; transport connectivity and failover; subscription interest; open/slow/closed streams; reconnect/resync behavior; event-loop lag; and invalidation-driven versus poll-driven refetches.
- **FR-033**: Logs, metrics, and traces MUST NOT contain message content, document content, prompt/completion data, credentials, or workspace/resource identifiers as metric labels.
- **FR-034**: Rollout MUST support reversible disabled, internal-canary, tenant-allowlisted, and default-on stages without changing the public event contract; percentage rollout is optional when supported cleanly by the existing flag system.
- **FR-035**: Existing document-worker, crawl-worker, action-dispatch, Cloud Tasks, and AMQP job payloads MUST remain backward compatible unless the implementation plan identifies and separately approves a required contract change.
- **FR-036**: Operator and self-hosted documentation MUST explain disabled, small hosted, and pre-scale capacity profiles; their infrastructure and cost boundaries; health signals; failure behavior; polling fallback; and a poll-only blue/green broker replacement/rollback procedure.
- **FR-037**: The live client MUST treat authorization failures and an explicitly disabled endpoint as terminal poll-only outcomes; treat `Retry-After` on `429` and `503` only as a minimum over jittered exponential backoff (including values above the local 30-second cap); ignore malformed frames safely; refresh stale authentication at most once per connection attempt; and reset reconnect backoff only after a stable connection. A self-host proxy with missing or invalid realtime configuration MUST return a sanitized, no-store `503` with `Retry-After: 60`, distinct from transient upstream failures with `Retry-After: 1`.
- **FR-038**: Gateway readiness MUST not be announced until workspace transport interest is active; disconnect during readiness, transport reconnect, and shutdown MUST release subscriptions and terminate streams without leaking connection state.

### Surface Coverage Map

| Surface | Invalidation kinds | Required behavior |
|---|---|---|
| Document list | `document.status_changed` | Cover both conditional and unconditional status paths plus publication of the ready document revision; reconcile visible document queries for worker-origin transitions |
| Crawl status and progress | `crawl.status_changed`, `crawl.progress` | Cover create, claim-by-scan, claim-by-id, pause, resume, stale release, `releaseForContinuation` yield-to-queued, deletion, cancellation by source, completion, failure, and checkpoint progress |
| Needs Attention and rail badge | `hitl.decision_created`, `hitl.decision_resolved`, `conversation.ownership_changed`, `quality.feedback_changed`, `quality.triage_changed` | Update counts while preserving operator-pull list behavior |
| History / All activity | `conversation.created`, `conversation.turn_committed`, `conversation.contact_delivery_changed`, `search.created` | Cover normal creation, create-once MCP anonymous sessions, create-once inbound Slack linking, every committed assistant turn, conditional contact-delivery transitions, and search audit activity; reconcile only the active workspace/filter/page slice |
| Quality review queue | `quality.feedback_changed`, `quality.triage_changed` | Reconcile rollup and rows without disrupting active review interactions |
| Knowledge Sources | `crawl.status_changed` | Discover starts and status changes from schedules, connectors, and other operators; keep high-frequency progress on its cheaper read cadence |

### Key Entities

- **Workspace invalidation**: A transient content-free statement that one or more bounded read-model kinds for a workspace may be stale.
- **Invalidation kind**: A versioned enum value mapping a committed domain transition to one or more authoritative frontend query families.
- **Realtime session**: One authenticated visible-dashboard connection scoped to an account, workspace, principal, expiry, and admission limits.
- **Observed query family**: A workspace-prefixed group of authoritative reads currently used by visible UI.
- **Recovery batch**: A bounded stale-crawl mutation result containing an aggregate released count, distinct affected workspace identities, and whether more work remains.

## Assumptions And Dependencies

- PostgreSQL remains authoritative for product state; the realtime transport stores no business data.
- Push loss is acceptable because reconnect reconciliation and visible-only poll floors guarantee convergence.
- The established authenticated fetch-stream client pattern can preserve the public event path and bearer/session behavior.
- Hosted and self-hosted deployments can provide a compatible transient publish/subscribe service when realtime is enabled.
- Existing TypeScript, Vitest, Playwright, Terraform, Cloud Run, VPC, and optional Redis client patterns are reused where appropriate.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With live delivery healthy, covered visible surfaces reflect committed changes with p95 under 2 seconds and p99 under 5 seconds, without manual refresh.
- **SC-002**: Whether live delivery is healthy, silently loses one publication, or is unavailable, covered visible surfaces converge within 60 seconds; a hidden tab converges within 5 seconds of becoming visible.
- **SC-003**: The required small-hosted acceptance runs two forced gateway instances with five tenants, about 50 simultaneously active workspaces, and 500 concurrent visible live streams. It includes one workspace spanning both gateways and verifies the hot-workspace and failure profiles without exceeding the small profile caps.
- **SC-004**: The required small producer harness sustains 10 post-commit invalidation requests per second for 15 minutes and injects a 500-request burst. It exercises a uniform 50-workspace distribution and a hot-workspace distribution with 50% of requests targeting one workspace; producer, broker, gateway, and frontend memory remain within configured bounds and return to a stable plateau. This criterion does not require unrelated product database mutations to execute at the harness rate.
- **SC-005**: A single hot workspace cannot exceed its configured publication and browser-frame rates or materially delay other workspaces in the same load test.
- **SC-006**: Broker outage or backpressure changes product-mutation p95 latency by no more than 2% or 5 milliseconds, whichever is larger, compared with realtime disabled.
- **SC-007**: Contract and isolation tests observe zero content-bearing frames and zero cross-workspace deliveries across all covered event kinds.
- **SC-008**: The required small-hosted acceptance includes a one-hour soak at five tenants, about 50 active workspaces, 500 streams, two forced gateway instances, and the small-profile producer rate. Post-warmup gateway heap remains within 10% of its stable baseline, configured producer and fan-out queues never exceed their caps, and a blocked connection retains only one bounded convergence marker before it is eventually closed.
- **SC-009**: Before selecting the pre-scale profile, an on-demand cloud-hosted run proves the 100,000-concurrent-stream upper envelope through horizontal scaling while each instance stays within its configured platform concurrency and measured headroom. This is not an ordinary small-hosted release gate.
- **SC-010**: Before selecting the pre-scale profile, a reconnect storm at that fleet size remains within configured gateway connection-admission and API reconciliation budgets with no synchronized fleet-wide spike.
- **SC-011**: Every covered backend transition has tests proving commit publishes after visibility, rollback publishes nothing, and bulk work is bounded.
- **SC-012**: Every affected frontend query family has tests proving workspace/filter isolation, cancellation, burst convergence, hidden-tab suspension, and reconnect reconciliation.
- **SC-013**: Realtime-enabled and realtime-disabled installation paths both pass documented smoke tests and health checks.
- **SC-014**: After every local connection for a workspace closes and the configured interest-release bound expires, the gateway has no remaining transport subscription or local fan-out state for that workspace; a churn test returns subscription and workspace-state counts to their pre-test baseline.

## Boundaries & Non-Goals

- No durable notification inbox, acknowledgement ledger, event replay, exactly-once delivery, or `Last-Event-ID` guarantee.
- No global event sequence, per-resource ordering contract, or client-side event-sourced state.
- No prompts, completions, messages, document bodies, chunks, credentials, or rich resource payloads over the live channel.
- No PostgreSQL `LISTEN/NOTIFY` production adapter and no fallback that presents an in-process bus as multi-instance-safe.
- No repository proxy/decorator layer that hides publication side effects in persistence adapters.
- No custom frontend request scheduler parallel to the shared query-cache authority.
- No migration of unrelated frontend server state outside the covered operator surfaces.
- No mobile push, email notification, or end-user widget protocol migration.
- No replacement of the existing conversation drawer or conversation-tail live-delivery behavior.
- No cross-region active-active realtime routing in this feature.
- No change to authoritative product storage or existing worker job durability semantics.
