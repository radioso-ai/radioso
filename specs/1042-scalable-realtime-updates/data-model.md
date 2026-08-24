# Data model: Scalable realtime workspace updates

This feature adds no authoritative database entity or event log. PostgreSQL remains authoritative for all product state. The entities below are contracts or bounded ephemeral runtime state.

## Invalidation kind

A versioned enum exported by `@radioso/workspace-invalidation-contract`.

Initial values:

- `document.status_changed`
- `crawl.status_changed`
- `crawl.progress`
- `conversation.created`
- `conversation.turn_committed`
- `conversation.contact_delivery_changed`
- `conversation.ownership_changed`
- `search.created`
- `hitl.decision_created`
- `hitl.decision_resolved`
- `quality.feedback_changed`
- `quality.triage_changed`

Rules:

- Unknown kinds are rejected at transport boundaries and ignored safely by older browser clients.
- Kinds describe stale read models, not exact resource mutations.
- Adding a kind requires backend publisher coverage, frontend mapping or an explicit no-consumer rationale, and contract compatibility tests.

## Workspace invalidation transport envelope

Fields:

- `protocolVersion`: literal current protocol version.
- `workspaceId`: UUID used only for transport routing and isolation validation.
- `changeKinds`: non-empty unique array of known invalidation kinds, capped at the enum size.

Rules:

- Strict schema; no extra content or resource payload.
- Serialized size is capped before publication and after receipt.
- The receiving adapter verifies that the envelope workspace matches the subscribed channel.
- No event ID, global sequence, timestamp, resource ID, ordering, or replay cursor.

## Browser event frame

Variants:

- `ready`: `{ protocolVersion }`
- `invalidate`: `{ protocolVersion, changeKinds }`
- `resync`: `{ protocolVersion }`

Rules:

- The authenticated stream supplies workspace scope; browser frames omit workspace identity.
- Heartbeats are SSE comments, not data frames.
- `resync` dominates pending `invalidate` state because a full observed-query reconciliation subsumes individual kinds.

## Producer pending entry

Fields:

- `workspaceId`: routing key.
- `changeKinds`: merged bounded set.
- `firstEnqueuedAt`: monotonic time for flush-latency observation.
- `eligibleAt`: next cadence boundary.

Lifecycle:

```text
absent -> pending -> flushing -> absent
                  \-> pending (new kinds arrive while flushing)
pending/flushing -> dropped (capacity, timeout, shutdown, or transport failure)
```

Rules:

- One entry per workspace per process.
- One global capacity bound and one bounded publish-concurrency pool.
- A scheduler owns all flush timing; entries do not own timers.
- No mutation path awaits an entry's delivery.

## Gateway workspace interest

Fields:

- `workspaceId`: map key.
- `connections`: bounded map of local realtime sessions.
- `transportState`: `subscribing | active | reconnecting | releasing`.
- `subscribePromise`: the one in-flight subscribe shared by concurrent first connections.
- `transportGeneration`: continuity generation that produced the active interest.
- `releaseAt`: optional monotonic deadline.
- `listener`: one callback registered with the transport adapter.

Lifecycle:

```text
no interest
  -> subscribing (first admitted connection)
  -> active (transport acknowledgment; stream may emit ready)
  -> reconnecting (transport continuity lost; local sessions require resync)
  -> active (interest restored; resync emitted)
  -> releasing (last local connection closed)
  -> no interest
```

Rules:

- One transport listener per locally active workspace, regardless of local connection count.
- Subscribe and unsubscribe operate on one sharded channel at a time with the exact same listener.
- A failed first subscription closes the pending stream without `ready`.
- A continuity-generation change restores interest before emitting one dominant resync.
- Interest and local state disappear within the configured release bound after the last connection.

## Realtime session

Fields:

- `connectionId`: random opaque runtime identifier.
- `accountId`, `workspaceId`, `userId`: authorization context; never metric labels.
- `openedAt`, `expiresAt`: bounded jittered lifetime.
- `writerState`: `idle | writing | blocked | closed`.
- `pending`: none, merged invalidation, or resync.
- `blockedSince`: optional monotonic time.
- `writableLength`: actual Node response buffer size observed by the writer pump.
- `lease`: tenant/principal admission lease handle.

Lifecycle:

```text
authenticating -> admitted -> subscribing -> ready -> streaming
                                      \-> rejected/closed
streaming -> blocked -> streaming | closed
streaming -> expiring -> closed -> browser reconnect/reauth
```

Rules:

- Only `ready` sessions count as live-delivery healthy.
- At most one pending convergence marker exists.
- Heartbeat and data frames share one serialized writer.
- No write occurs after `res.write()` returns false until `drain`; blocked duration
  and writable length are independent close conditions.
- Close is idempotent and releases local interest plus operational admission lease.

## Admission lease

Ephemeral Redis state is grouped into the account/tenant hash slot so one atomic
script can enforce account, workspace, and principal concurrency together.

Fields:

- `accountId`: key hash tag and tenant limit scope.
- `workspaceId`: workspace concurrency scope within the account.
- `principalHash`: one-way hash of the authenticated user identifier; the
  principal limit applies across this account, not only one workspace.
- `instanceId`: random gateway-instance identifier.
- `localCount`: active local sessions represented by the lease.
- `expiresAt`: lease expiry used to heal process death.

Rules:

- Keys `rt:admission:{accountId}:expiry`, `:leases`, and `:counts` share one
  cluster slot. The expiry key is a ZSET of aggregate ID to server-time expiry;
  leases is a HASH of aggregate ID to encoded workspace/principal/local-count;
  counts is a HASH containing account total plus workspace and principal totals.
- Aggregate ID is a random instance ID plus workspace ID and principal hash. It
  represents all matching local connections on one gateway, not one Redis member
  per browser connection.
- Every mutation is a serialized compare-and-set for one local aggregate:
  `(expectedCount, desiredCount)`. The Lua operation accepts when stored count
  equals expected, applies the exact derived delta to all counters, and records
  desired. If stored already equals desired, it returns the prior success as an
  idempotent replay after a lost reply. Any other value is a fenced conflict that
  cannot guess or double-apply a delta.
- `acquire` changes `n -> n+1`; `release` changes `n -> n-1` or `n -> 0`; renew
  changes `n -> n` while refreshing expiry. All use Redis `TIME`, bounded expiry
  pruning, limit checks for positive deltas, and one atomic Lua operation.
- The gateway serializes changes per aggregate and updates its local expected
  count only after a CAS success/replay result. A lost reply, client retry,
  duplicate close, or late completion therefore cannot overcount or undercount.
- If more expired aggregates remain after the cleanup cap, new acquisition fails
  closed and a bounded process-level sweeper continues cleanup; no operation
  scans all connections, principals, workspaces, or lease fields.
- The process slot is reserved before distributed acquire. Auth/subscribe failure
  releases both. Renewal failure marks admission degraded and jitter-closes the
  stream before lease expiry; process death heals through bounded expiry pruning.
- Leases contain no product content and are not authoritative.

## Workspace query key

Canonical prefix:

```text
['workspace', workspaceId, family, ...discriminators]
```

Families and discriminators:

- `documents.list(workspaceId, { sourceId, page, pageSize })`.
- `documents.crawlActivity(workspaceId, { recentSinceMinutes })`.
- `sources.list(workspaceId)`.
- `sources.crawlState(workspaceId)`.
- `history.slice(workspaceId, { filter, page, pageSize })`.
- `quality.stats(workspaceId, { range })`.
- `quality.turns(workspaceId, normalizedFiltersAndPage)`; set-like filters are sorted.
- `attention.decisions(workspaceId)`.
- `attention.humanOwned(workspaceId, { pageSize })`.

Rules:

- Workspace ID and every authoritative result discriminator are mandatory.
- Query functions accept and forward an AbortSignal.
- Live invalidation targets families; only active observers refetch immediately.
- Needs Attention presentation maintains a separate operator-controlled displayed
  snapshot; the latest Query result may advance without replacing that snapshot.

## Recovery batch

Fields:

- `releasedCount`: integer between zero and configured batch size.
- `workspaceIds`: distinct set, capped by released count and batch size.
- `hasMore`: whether another bounded pass may find work.

Rules:

- Selection locks at most `limit + 1` eligible rows in one transaction using
  `FOR UPDATE SKIP LOCKED`; mutation touches only the first `limit`, and the
  bounded extra row determines `hasMore` without an unbounded count.
- No job ID array crosses the repository boundary.
- After commit, the worker enqueues at most one `crawl.status_changed` invalidation per returned workspace.
- The poller immediately repeats recovery while `hasMore`, including when
  `claimNext` finds no runnable job. Continuation does not create or change a
  durable queue payload; task payload remains exactly `{ jobId, workspaceId }`.

## Post-commit invalidation receipt

A pure in-memory value used only when a persistence operation may execute inside
a caller-owned transaction.

Fields:

- `workspaceId`.
- `changeKinds`: bounded merged set from the strict version-1 enum.

Rules:

- Persistence and repositories may construct/return a receipt but never enqueue it.
- Nested receipts merge by workspace/kind without resource payloads.
- Only the outermost application transaction owner flushes after commit.
- Rollback discards the receipt. A no-op transition contributes no kind.
