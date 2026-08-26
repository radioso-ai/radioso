# Quickstart validation: Scalable realtime workspace updates

## Prerequisites

- Node.js 24 and the repository `pnpm` workspace installed.
- PostgreSQL 16 test database.
- Redis or Valkey 7+ standalone for local functional checks.
- A three-primary cluster with replicas only for opt-in pre-scale sharded Pub/Sub topology/failover checks.
- Playwright browsers installed for frontend journeys.

Do not use customer data, production broker credentials, or production workspace identifiers in these checks.

## 1. Contract and bounded producer

1. Build and test `@radioso/workspace-invalidation-contract`.
2. Run backend tests proving strict content-free envelopes and browser frames.
3. Run producer tests with repeated kinds, many workspaces, full capacity, publish timeout, broker disconnect, and shutdown.
4. Confirm the mutation caller returns before any broker promise settles and all queue sizes stay within configured caps.

Expected: kinds coalesce per workspace; new-workspace work drops observably at capacity; no content-bearing field is accepted.

## 2. Standalone transport and gateway

1. Start a local Redis/Valkey 7 instance.
2. Start the backend API, worker runtime, and dedicated realtime runtime in `standalone` mode.
3. Open two authenticated dashboard contexts in one workspace.
4. Publish a covered transition from the other context or a worker.
5. Verify both contexts receive content-free invalidation and refetch authoritative APIs.
6. Close every local connection and wait past the interest-release bound.

Expected: one transport subscription per active local workspace, one stream per visible dashboard context, no residual workspace interest after close.

## 3. Authentication, visibility, and failure convergence

1. Open a stream, revoke the user's membership, and wait through the maximum jittered stream age.
2. Verify reconnect is rejected and the browser remains poll-only.
3. Hide a tab; confirm the stream closes and ordinary covered polling stops.
4. Change state while hidden, restore visibility, and verify reconciliation within five seconds.
5. Stop Redis while a stream is ready, change state, and verify the visible query converges within 60 seconds through polling.
6. Restore Redis and verify the gateway resubscribes, emits `resync`, and the client reconciles without replay.

Expected: realtime failure never changes mutation outcome and never creates permanent staleness.

## 4. Pre-scale cluster topology and isolation (opt-in)

1. Start the three-primary Redis/Valkey cluster.
2. Subscribe gateway instances to workspaces mapped to different slots.
3. Verify `SPUBLISH` reaches every gateway with local interest and no gateway without interest.
4. Move a subscribed channel's slot to another primary and perform a primary failover.
5. Verify reconnect/resubscribe and `resync` behavior.
6. Publish an envelope whose workspace does not match its channel.

Expected: topology changes recover without durable history; mismatched envelopes are dropped; no cross-workspace browser frame is emitted.

## 5. Covered operator journeys

Run Playwright journeys with independent browser contexts for:

- document status and ready-revision transitions;
- externally started crawl visible in Documents and Sources;
- History current filter/page updates without other-slice refetch;
- Quality feedback/triage updates with data preserved during background failure and active-review deferral;
- inbox and Needs Attention count updates without automatic list replacement;
- workspace switch during an in-flight response;
- reconnect, `resync`, malformed frame, terminal auth/disabled response, and `Retry-After` handling;
- hidden-tab disconnect and visibility reconciliation.

Expected: live healthy p95 is under two seconds and all visible covered surfaces converge within 60 seconds even after silent loss.

## 6. Bounded crawl recovery

1. Seed a stale crawl backlog much larger than the configured recovery batch and distribute jobs unevenly across workspaces.
2. Run one recovery pass concurrently from multiple worker instances.
3. Verify each transaction releases at most the configured batch using non-overlapping locked rows.
4. Verify results contain only aggregate count, distinct bounded workspaces, and `hasMore`.
5. Continue until idle and confirm one crawl invalidation per affected workspace per batch.

Expected: lock duration, returned data, logs, and fan-out remain bounded independent of backlog size.

## 7. Capacity and soak profiles

Run the required small hosted profile through the real external load balancer
with production session auth and admission (never direct-gateway or auth bypass):

- five tenants, about 50 active workspaces, 500 concurrent streams, and two
  forced realtime gateway instances;
- 10 post-commit invalidation requests/second for 15 minutes and a 500-request
  one-second burst, including a 50%-hot-workspace case;
- blocked readers, connection/interest churn, deployment reconnect jitter,
  broker interruption/recovery, and one cross-gateway workspace;
- a required one-hour soak at that same five-tenant/~50-workspace/500-stream,
  two-gateway profile.

Expected: small-profile caps hold, live p95/p99 and <=60-second fallback targets
pass, no frontend Cloud Run request carries a stream, interest returns to baseline
within five seconds, and memory reaches a stable plateau.

Run the following only after approving the pre-scale profile and its quota/cost
preflight: 5,000/s for 15 minutes, a 50,000-request burst, 10,000 tenants, 2,000
workspaces, 100,000 **concurrent streams**, a real-browser cohort, reconcile
floor budget, failover, and a one-hour hosted soak. This profile validates the
10 → 50 → 150 gateway ramp; it is not an ordinary release gate.

## 8. Deployment modes

1. Start with realtime disabled and no Redis configuration.
2. Verify health, no client reconnect loop, and 45–60 second visible-query convergence.
3. Start realtime enabled with invalid configuration and verify readiness fails clearly while the main API remains independently operable.
4. Start with valid standalone configuration, then with the small hosted
   cluster-disabled Valkey configuration (IAM/TLS, min 0/max 3).
5. Verify hosted Cloud Armor rate limiting, restricted ingress/default-URL
   bypass rejection, and exact path routing; verify the self-hosted exact proxy's
   request/response header allowlists and disconnect propagation separately.
6. Exercise and record disabled → small-hosted internal canary → tenant allowlist
   → default-on → disabled rollback. For a pre-scale upgrade, remain poll-only,
   deploy the replacement clustered broker, switch configuration, validate, then
   re-enable realtime; do not attempt an in-place broker-mode change.

Expected: disabled, self-hosted standalone, small hosted, and pre-scale cluster
modes have explicit health, cost boundary, and rollback behavior.
