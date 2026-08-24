# Research: Scalable realtime workspace updates

## Hosted transport and topology

**Decision**: Run an independently scalable realtime Cloud Run service and use Memorystore for Redis Cluster as transient inter-process fan-out. Use Redis 7+ sharded Pub/Sub (`SPUBLISH`, `SSUBSCRIBE`, `SUNSUBSCRIBE`) with one shard channel per workspace. Keep PostgreSQL authoritative and retain no event history.

**Rationale**: Cloud Run instances are independent and a connection can land on any instance. Google recommends Redis Pub/Sub for synchronizing realtime connections across Cloud Run instances, and Memorystore Redis Cluster explicitly supports sharded Pub/Sub. Sharded channels limit propagation to the owning shard instead of broadcasting every message across the whole cluster.

**Alternatives considered**:

- Google Cloud Pub/Sub: rejected for gateway broadcast. Multiple subscribers on one subscription load-balance messages; fan-out requires a distinct subscription for each consumer. Autoscaled ephemeral gateway instances make that topology expensive and operationally awkward.
- RabbitMQ/AMQP: retained for durable worker jobs, rejected for ephemeral browser invalidation because it creates a second per-gateway queue lifecycle and couples browser acceleration to the job broker.
- PostgreSQL `LISTEN/NOTIFY`: rejected because global database broadcast, listener connection pressure, and one database failure domain do not meet the target topology.
- Redis Streams, Kafka, or durable Cloud Pub/Sub: rejected because replay and durable event state are unnecessary; authoritative refetch and the always-on poll floor provide correctness.

**Sources**:

- [Cloud Run WebSocket synchronization guidance](https://docs.cloud.google.com/run/docs/triggering/websockets)
- [Google Cloud Pub/Sub delivery patterns](https://docs.cloud.google.com/pubsub/docs/pubsub-basics)
- [Memorystore Redis Cluster command support](https://docs.cloud.google.com/memorystore/docs/cluster/supported-commands)
- [Redis sharded Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)

## Redis client and deployment modes

**Decision**: Pin `redis` 6.2.1 as a direct backend dependency. The version was
verified from the npm registry on 2026-08-25. Provide two transport adapters
behind one narrow port:

- `cluster`: cluster discovery plus sharded Pub/Sub for hosted and clustered self-hosted deployments;
- `standalone`: ordinary `PUBLISH`/`SUBSCRIBE` for one-node Redis or Valkey;
- `disabled`: a no-op producer and no realtime runtime, leaving the frontend on its poll floor.

Use distinct publisher and subscriber cluster clients with mandatory error
listeners, bounded command queues, disabled publisher offline accumulation,
command/connect timeouts, exponential reconnect backoff with jitter, and explicit
shutdown. In cluster mode, subscribe/unsubscribe one sharded workspace channel at
a time so a multi-channel command cannot cross slots. Channel names include an
explicit environment prefix and a Redis hash tag around the workspace UUID;
node-redis key-prefix configuration is not relied on for Pub/Sub channels.

**Rationale**: node-redis supports `RedisCluster.sPublish`/`sSubscribe`, topology discovery, dedicated Pub/Sub handling, and async credential providers. Release 6.2.1 contains the June 2026 sharded-subscription slot-migration repair; our adapter must still prove reconnect, failover, and in-place slot migration through integration tests rather than trusting client behavior implicitly.

**Alternatives considered**:

- Reusing `packages/radioso-mcp-server`'s Redis client: rejected. That package owns durable MCP runtime state, pins node-redis 4.x, and must not become an application-wide realtime transport.
- ioredis: viable, but node-redis now has the required dynamic subscription and sharded migration behavior with a smaller new dependency surface.
- Valkey GLIDE: promising and GCP-backed, but its Node dynamic Pub/Sub surface is newer and introduces a native Rust-backed runtime. Keep the transport port narrow so it can be evaluated later without changing domain code.

**Sources**:

- [node-redis Pub/Sub API](https://github.com/redis/node-redis/blob/master/docs/pub-sub.md)
- [node-redis cluster configuration](https://github.com/redis/node-redis/blob/master/docs/clustering.md)
- [Sharded subscription migration fix](https://github.com/redis/node-redis/pull/3313)
- [Valkey Pub/Sub semantics](https://valkey.io/topics/pubsub/)

## Memorystore security and networking

**Decision**: Provision a highly available, multi-zone Memorystore Redis Cluster through `google_redis_cluster`, Private Service Connect, and the existing VPC/Direct VPC egress model. Enable TLS and IAM authentication. Grant `roles/redis.dbConnectionUser` only to API, document-worker, crawler-worker, and realtime service accounts. Retrieve IAM access tokens on demand through a node-redis async credentials provider; never store access tokens in configuration.

The cluster stores only transient invalidations and short-lived operational admission leases. Persistence is disabled. Production has at least one replica per shard; shard and node sizes remain Terraform variables and are validated by the load profile before default-on rollout.

**Rationale**: Memorystore clusters are private behind PSC. IAM auth avoids static broker passwords; TLS protects authentication tokens at the application layer. Memorystore documents that access tokens are short-lived and should be fetched on demand for new connections. Existing authenticated connections remain usable through token expiry, so reconnect paths must always fetch fresh credentials.

**Alternatives considered**:

- Static token authentication: simpler, but creates a new long-lived secret rotation obligation.
- Disabled auth on private networking: rejected for hosted production; private reachability alone does not provide workload identity or least privilege.
- Broker persistence: rejected because invalidations are non-authoritative and must not become a hidden data store.

**Sources**:

- [Memorystore Redis Cluster security](https://docs.cloud.google.com/memorystore/docs/cluster/security-overview)
- [IAM authentication behavior](https://docs.cloud.google.com/memorystore/docs/cluster/about-iam-auth)
- [TLS guidance](https://docs.cloud.google.com/memorystore/docs/cluster/about-in-transit-encryption)
- [Memorystore Redis Cluster networking](https://docs.cloud.google.com/memorystore/docs/cluster/networking)
- [Terraform `google_redis_cluster`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/redis_cluster)

## Cloud Run capacity and routing

**Decision**: Add `realtimeServer.ts` and `startRealtimeRuntime.ts` to the backend image. The runtime builds only session/workspace authorization, admission, Redis subscription, fan-out, SSE, health, logging, metrics, and tracing dependencies; it does not run database migrations or construct the full API graph.

Hosted traffic does not traverse the frontend Cloud Run service. The existing
external Application Load Balancer gains an exact `/backend/api/v1/events` path
rule and rewrite to the gateway's `/api/v1/events` route on a realtime serverless
NEG, while all other paths continue to the frontend. The realtime service uses
`internal-and-cloud-load-balancing` ingress, disables its default URL, and grants
`roles/run.invoker` to `allUsers` because external load-balancer browser requests
carry no Google identity token. Edge restriction, Cloud Armor, and mandatory
application session/workspace authentication form the access boundary; the
runtime service account separately holds only DB/Redis/telemetry permissions.
Cloud Armor provides pre-auth connection-attempt protection by source IP on the realtime
backend. The gateway still authenticates the dashboard session cookie plus
`X-Workspace-Id`, so edge reachability grants no workspace access and membership
changes are rechecked on every jittered reconnect.

Local and self-hosted installs use an exact Next App Router endpoint at
`frontend/app/backend/api/v1/events/route.ts` to stream to
`REALTIME_INTERNAL_URL`; production reverse proxies may route the exact path
directly instead. The exact route is GET-only, allowlists request and response
headers, strips caller-supplied authorization/forwarding/hop-by-hop headers,
forwards the abort signal, streams without buffering, and returns generic
upstream errors. It does not infer client origin from caller-controlled headers;
the documented self-hosted reverse proxy owns that pre-auth limit. The existing
catch-all backend proxy is not modified for realtime behavior.

Gateway Cloud Run concurrency is explicitly 1,000 and application admission is
900 streams per instance, leaving request headroom. A 150-instance ceiling gives
capacity above the 100,000-stream target during rollout and drain. Gateway and
load-balancer backend timeouts start at 1,200 seconds. Streams end at a random
12–14 minutes and are further capped by session expiry minus skew and every
request-timeout margin.

**Rationale**: Cloud Run permits at most 1,000 concurrent requests per instance
and at most a 60-minute request timeout. The 100,000-connection objective is
therefore a fleet target. Exact load-balancer routing keeps the browser
same-origin without doubling every stream into simultaneous frontend and gateway
Cloud Run requests.

**Alternatives considered**:

- Hosting the stream on the main API: rejected because long connections would force API and realtime scaling to move together.
- Proxying hosted streams through Next.js: rejected because it doubles long-lived
  Cloud Run requests and couples frontend fleet capacity to realtime load.
- Direct browser access to a public `run.app` URL: rejected because dashboard session cookies and same-origin protections would be weakened or require a separate ticket protocol.
- Workspace bearer token auth: rejected for the dashboard stream because it is shared workspace authority and does not prove the connecting user's current membership.

**Sources**:

- [Cloud Run concurrency limits](https://docs.cloud.google.com/run/docs/about-concurrency)
- [Cloud Run request timeout](https://docs.cloud.google.com/run/docs/configuring/request-timeout)
- [Cloud Run quotas](https://docs.cloud.google.com/run/quotas)

## Shared contract and publisher boundary

**Decision**: Create `@radioso/workspace-invalidation-contract` as a small runtime workspace package containing the protocol version, bounded invalidation-kind enum, strict Zod schemas, transport envelope, and browser frame schemas. It knows no Redis channels, HTTP routes, frontend query keys, or domain services.

Backend domain/application modules depend on a local `WorkspaceInvalidationPublisher` port with synchronous `enqueue(workspaceId, kinds): EnqueueResult`. Composition supplies either a bounded coalescing publisher or a no-op. Domain calls happen only after the owning transaction returns successfully. Persistence repositories never publish.

**Rationale**: One package prevents backend/frontend wire drift without coupling domain modules to UI query families. A synchronous bounded enqueue makes it impossible for a product mutation to await broker I/O.

## Bounded producer

**Decision**: Use a process-global bounded map of workspace to merged invalidation kinds, a single scheduler, a configurable per-workspace cadence, and bounded publish concurrency. Existing workspace entries can always merge kinds; a new workspace is dropped when the global cap is full. A failed or timed-out publish is observed and discarded. Graceful shutdown attempts one bounded flush without extending mutation latency.

The Redis client has no unbounded offline queue. Metrics record accepted, coalesced, cap-dropped, publish-failed, and flush-latency outcomes without workspace labels.

**Rationale**: The state needed for convergence is a set of bounded kinds, not an event list. Retrying transient messages during an outage only moves the unbounded queue into the application and provides no correctness benefit over the poll floor.

## Gateway interest, fan-out, and admission

**Decision**: Maintain a bounded map keyed by workspace. Each entry has local
connection references, exactly one transport listener, a single-flight
subscribe promise, a transport generation, and an optional bounded release
deadline. Concurrent first connections await the same subscription. A last
disconnect while subscribing transitions to release, an immediate reconnect
cancels delayed release, and unsubscribe uses the exact registered listener.
The transport receives Buffer payloads, enforces the byte cap before UTF-8/JSON
allocation, and verifies channel-derived workspace scope against the envelope.

One writer pump owns every `res.write`. Each frame is one bounded buffer and one
write call. When a write returns false, the pump waits for `drain`; later changes
merge into one pending marker, `resync` dominates, and heartbeats coalesce behind
convergence work. Both blocked duration and `res.writableLength` are enforced.
Redis reconnect, failover, slot move, or subscription-generation change marks
affected interests reconnecting. New sessions receive no `ready` until interest
is restored; existing sessions receive one dominant `resync` after restoration.
Duplicate delivery during handoff is harmless.

After authentication, the process slot is reserved first. Account/tenant,
workspace, and account-principal limits then use Redis server-time leases grouped
by account hash slot. One aggregate represents
`(workspace, principalHash, gatewayInstance)` with an exact local count. Atomic
Lua operations maintain an expiry ZSET, aggregate HASH, and account/workspace/
principal counter HASH: acquire applies `+1`, renew reconciles to the exact local
count, and release applies `-1`. Every operation prunes at most the configured
number of expired aggregates; remaining stale backlog fails acquisition closed
and is reduced by a bounded sweeper. No operation scans connections, workspaces,
or principals. Auth/subscribe failure releases both layers idempotently.

Pre-auth origin rate limiting belongs at Cloud Armor in hosted mode and at the
documented reverse proxy/local exact-route cap in self-hosted mode. Post-auth
Redis token buckets are separate account, workspace, and account-principal
reconnect controls. Caller-supplied forwarding chains are never trusted.

If admission cannot be verified, new streams receive `503` plus jittered
`Retry-After`. Renewal failure marks readiness false and admission degraded;
existing streams retry only within their lease safety window and jitter-close
before the lease can expire. Liveness stays true and browsers remain poll-only.

**Rationale**: Ref-counted interest makes broker work proportional to active local workspaces. Operational leases provide fleet-wide limits without putting business state in Redis. One convergence marker bounds every slow-client path.

## Frontend server-state substrate

**Decision**: Add TanStack Query 5.102.3 and mount one `QueryClient` per canonical
workspace dashboard session after workspace resolution. Migrate only Documents,
Sources/crawl, History list, Quality, and Needs Attention/rail reads. Every key
starts with `['workspace', workspaceId, ...]` and contains all filter, page,
source, range, and page-size discriminators that affect its result.

A centralized registry maps invalidation kinds to active exact semantic key
variants. The workspace event provider owns one visible-tab fetch-stream; views
do not subscribe to events. If a matching query is already fetching, the
coordinator records one dirty bit by active query hash and performs one trailing
reconciliation when it becomes idle. Query functions forward TanStack's
`AbortSignal`. TanStack Query is the only request-deduplication and stale-result
authority.

Covered visible queries retain jittered 45–60 second intervals with `refetchIntervalInBackground: false`. The event provider disconnects while hidden and invalidates currently observed workspace queries once on visibility restoration, initial `ready`, reconnect, or `resync`.

Quality freezes only its rendered current-page snapshot while a close-review or
triage interaction is active; its Query remains enabled and may update in the
background. Success/conflict invalidates before unfreeze, and cancel unfreezes.
Sources and Quality retain displayed data on background failure. Needs Attention
keeps latest Query data separate from the operator-controlled displayed-list
snapshot so live invalidation updates counts without injecting rows.

**Rationale**: Query keys provide workspace/filter isolation and built-in cancellation/deduplication. A single invalidation registry prevents callback trees and competing component-local schedulers.

**Source**: [TanStack Query `useQuery` reference](https://tanstack.com/query/latest/docs/framework/react/reference/useQuery)

## Bounded crawl recovery

**Decision**: Replace the unbounded stale-release statement with a repository
operation that locks at most `limit + 1` rows using `FOR UPDATE SKIP LOCKED`,
mutates only the first `limit` in the same transaction, and returns
`{ releasedCount, workspaceIds, hasMore }`. Workspace IDs are distinct and
bounded. The crawler poller immediately runs another recovery pass while
`hasMore`, even if `claimNext` found no runnable job; publication happens once
per returned workspace after commit. Aggregate released-row, workspace, batch,
and continuation telemetry is low-cardinality. The durable task payload remains
exactly `{ jobId, workspaceId }`.

Checkpoint persistence keeps PR #1078's independent one-second coalescing fix, including terminal/error/yield flushes.

**Rationale**: Database lock time, return payload, logs, and invalidation fan-out remain proportional to a configured batch even when the stale backlog is enormous.

## Observability and performance acceptance

**Decision**: Add low-cardinality metrics and spans at producer enqueue/flush, Redis connect/reconnect, gateway interest, stream admission/write/close, resync, and frontend live/poll reconciliation boundaries. Logs may include correlation IDs already allowed by repository policy but no prompts, document content, frame content, credentials, or identifier-valued metric labels.

Extend the existing performance harness with committed-transition publisher,
gateway connection, hot-workspace, reconnect-storm, blocked-client,
subscription-churn, mandatory reconcile-floor API load, frontend coordinator,
and one-hour soak profiles. The 5,000/s run lasts 15 minutes and the
50,000-in-one-second test exercises post-commit publisher inputs rather than
unrelated database mutations. The hosted fleet run uses the real load-balancer
path and production auth/admission for 100,000 simultaneous streams; its compact
acceptance report records topology, quotas, sizing, ramp, numerical SLOs, and
pass/fail.

## Public and queue contract impact

**Decision**: Register `GET /api/v1/events` in the code-first OpenAPI document as
dashboard-session-cookie-only and regenerate backend OpenAPI plus TypeScript SDK
and MCP type snapshots. The API-token SDK gains no convenience method and MCP
gains no tool/event surface. The endpoint is transport-only and receives an
explicit operator-copilot coverage exclusion.

Existing AMQP, Cloud Tasks, document-worker, crawl-worker, and action-dispatch payloads do not change. Invalidation is a new side-channel invoked after their authoritative commits, so queue retry, dead-letter, and job durability semantics remain unchanged. Contract tests must pin this non-impact.

## PR #1078 reuse

**Decision**: Follow [pr1078-salvage.md](./pr1078-salvage.md). No realtime feature commit is cherry-picked wholesale. The checkpoint fix is isolated; the Slack fixture hunk and action-dispatch result fix are reconstructed separately; useful SSE/client/product behaviors and tests are ported through the new boundaries.
