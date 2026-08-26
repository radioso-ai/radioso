# PR #1078 Salvage Matrix

PR #1078 is a behavior and regression-test source, not an implementation base. Its realtime commits predate current `origin/main`, combine unrelated concerns, and implement the PostgreSQL topology explicitly rejected by the approved specification.

## Isolated fixes

| Source | Disposition | Scope |
|---|---|---|
| `c46dba4056` | Cherry-pick as its own commit | Crawl checkpoint persistence throttle and terminal/error/yield flush tests in `backend/src/modules/websiteCrawler/service.ts` and its unit test |
| `77eb31b0a` | Extract only the five-line test hunk | Missing `conversations` stub in `backend/tests/integration/slack/slack-skill-migration.integration.test.ts`; do not copy the mixed commit |
| `9bd5e16e7` | Reimplement as its own fix | Make `markDispatched` report whether a row actually changed and publish contact-delivery invalidation only for committed transitions; the commit does not apply to current main |

## Port and rewrite

- Port the generic SSE presenter intent and the stash's atomic one-write frame plus serialized backpressure/cancellation behavior. Rewrite its contradictory old tests.
- Rewrite the authenticated event endpoint in a dedicated realtime runtime. Preserve subscribe-before-`ready`, disconnect-during-readiness cleanup, heartbeat serialization, resync, overload guidance, bounded stream age, and shutdown behavior.
- Rewrite the wire contract and fetch-stream client around versioned `ready`, `invalidate`, and `resync` frames with bounded `changeKinds[]`. Preserve one-shot token refresh, malformed-frame rejection, terminal poll-only responses, stable-connection backoff reset, and reconnect reconciliation.
- Use PR #1078's publisher tests as the transition inventory, but publish explicitly from application-service post-commit seams for documents, crawl jobs, conversations, assistant turns, search audit, HITL, ownership, quality, and contact delivery.
- Rewrite stale-crawl recovery as bounded `FOR UPDATE SKIP LOCKED` batches returning aggregate count, distinct workspaces, and `hasMore`; publish once per affected workspace per batch.
- Port covered frontend behavior to workspace-prefixed TanStack Query keys and AbortSignals. Retain History slice isolation, 45–60 second visible floors, Sources' cheaper known-active progress, Quality interaction deferral, background-data preservation, and Needs Attention's operator-pull list.
- Adapt the two existing Playwright journeys and add Documents, History, Needs Attention, isolation, reconnect/resync, hidden-tab, and slow-client coverage.
- Rewrite low-cardinality observability for producer enqueue/coalesce/drop, broker connectivity, gateway interest and streams, resync, event-loop lag, and live-versus-poll refetch.
- Rewrite the code-first public event contract and regenerate OpenAPI, TypeScript SDK, and MCP snapshots from current main.

## Discard

- PostgreSQL `LISTEN/NOTIFY`, raw listener connections, its integration tests, and listener lifecycle wiring.
- The global sequence migration and every ordering or replay assertion.
- `workspacePushRepositoryDecorators.ts` and every persistence-owned or awaited publication side effect.
- A combined publisher/subscriber `WorkspaceEventBus`; producer and gateway ports must remain narrow and separate.
- Main API ownership of long-lived streams.
- Browser fields `resourceType`, `resourceId`, `workspaceId`, and global `version` from the old frame.
- `use-coalesced-async`, `use-background-refresh`, `use-scoped-single-flight-refresh`, and their generic tests.
- PR #1078's generated API/SDK snapshots, provider-specific docs, Spec 106 artifacts, and merge commit.

## Required additions absent from PR #1078

- Redis/Valkey standalone and cluster adapters, Memorystore networking and discovery, and failover/topology tests.
- An independently scalable Cloud Run realtime service and explicit polling-only deployment mode.
- Configurable tenant, principal, and process admission; ref-counted workspace interest and leak tests.
- Fleet, hot-workspace, reconnect-storm, blocked-client, and soak harnesses.
- Visibility-driven browser disconnect and a shared TanStack Query cache substrate.
- Crawl deletion, source cancellation, and bounded multi-batch stale recovery.

## Integration rule

No realtime feature commit is cherry-picked wholesale. Each retained behavior is introduced through the ownership seam in `plan.md`, under current-main tests, and in a small reviewable commit. The isolated fixes above remain separate from realtime acceptance.
