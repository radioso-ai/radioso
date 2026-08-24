# Contract: Workspace event stream

## HTTP endpoint

```http
GET /api/v1/events
Accept: text/event-stream
Cookie: <dashboard session cookie>
X-Workspace-Id: <workspace UUID>
```

The same-origin browser path is `/backend/api/v1/events`. Hosted GCP routes this
exact path at the external load balancer directly to the independently deployed
realtime service. Local/self-hosted mode uses a dedicated exact frontend proxy
route unless the operator's reverse proxy routes it directly. The ordinary
catch-all API proxy is not the realtime data plane. The backend code-first
OpenAPI registry remains the public contract source.

Authentication is dashboard-session-only. Workspace API tokens and anonymous/public-chat sessions are rejected. Authentication verifies an active session, active account membership, and that the selected workspace belongs to that account.

## Success response

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Compression is disabled for this response. The runtime authenticates, reserves
local and distributed admission, and establishes workspace transport interest
before committing HTTP 200 or sending `ready`.

### Ready

```text
event: ready
data: {"protocolVersion":1}

```

The client reconciles all currently observed query families for the authenticated workspace.

### Invalidate

```text
event: invalidate
data: {"protocolVersion":1,"changeKinds":["document.status_changed","crawl.status_changed"]}

```

`changeKinds` is non-empty, unique, known to the current contract, and capped at the total enum size. The client marks mapped query families stale; only active observers refetch immediately.

### Resync

```text
event: resync
data: {"protocolVersion":1}

```

The runtime sends `resync` after transport continuity is lost or local pending state can no longer represent specific invalidations. The client reconciles all currently observed workspace query families. No replay follows.

### Heartbeat

```text
: heartbeat

```

Heartbeats contain no data and use the same serialized writer as event frames.

## Error and overload responses

| Status | Client behavior |
|---|---|
| `400` | Treat malformed workspace selection as terminal until application state changes. |
| `401` | Attempt one normal session refresh/login recovery path; otherwise remain poll-only. |
| `403` | Terminal poll-only; do not reconnect until authorization state changes. |
| `404` | Realtime disabled; terminal poll-only for this application load. |
| `429` | Honor `Retry-After`, then retry with jitter while visible. |
| `503` | Honor `Retry-After`; remain poll-correct and retry with jitter while visible. |

The client ignores malformed or unknown frames, records an aggregate diagnostic, and keeps its poll floor. Reconnect backoff resets only after a stable ready connection.

## Transport envelope

The Redis/Valkey payload is internal and is not returned directly to browsers:

```json
{
  "protocolVersion": 1,
  "workspaceId": "4d7293c8-d241-4f8f-a4db-3df5b88da44c",
  "changeKinds": ["quality.triage_changed"]
}
```

Cluster channel shape:

```text
<namespace>:workspace:{<workspace UUID>}
```

The workspace hash tag distributes Pub/Sub channels across slots. Admission is a
separate key family tagged by account ID so account, workspace, and principal
counters are atomic within the account slot; admission keys are not colocated
with Pub/Sub channels. The subscriber validates envelope workspace identity
against its expected channel before fan-out. Payloads exceeding the configured
byte cap are rejected.

## Compatibility

- Protocol version 1 has no event ID, sequence, cursor, timestamp, resource ID, or replay guarantee.
- Protocol version 1 kinds are exactly `document.status_changed`,
  `crawl.status_changed`, `crawl.progress`, `conversation.created`,
  `conversation.turn_committed`, `conversation.contact_delivery_changed`,
  `conversation.ownership_changed`, `search.created`,
  `hitl.decision_created`, `hitl.decision_resolved`,
  `quality.feedback_changed`, and `quality.triage_changed`.
- Adding an invalidation kind is backward compatible: an older client ignores an unknown kind and remains correct through its poll floor.
- Changing an existing frame shape or event semantic requires a protocol-version review.
- Existing document-worker, crawl-worker, action-dispatch, Cloud Tasks, and AMQP payloads are unaffected.
