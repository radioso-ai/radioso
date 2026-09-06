---
title: "App Runtime Protocol"
description: "The wire contract between a Radioso host and an App: invocation requests and responses per input kind, host capability calls, error codes, and the App Job wake-up envelope."
last_updated: 2026-09-06
---

# App Runtime Protocol

An App runs as its own program. The host sends it invocations; it answers with
an outcome and calls back for anything it needs from the platform. Both
directions are JSON, both are schema-checked at the boundary, and both are
versioned by `protocolVersion: 1`.

The schemas are in `@radioso/app-contract`, so a host, an App, and the
conformance harness all validate the same bytes the same way.

## An invocation

The host sends one request per unit of work:

```json
{
  "protocolVersion": 1,
  "invocationId": "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
  "installationId": "1d2e3f40-1111-4222-8333-444455556666",
  "contributionId": "content_push",
  "executionClass": "external_webhook",
  "attempt": 1,
  "idempotencyKey": "delivery:6f0f1c2d",
  "deadlineAt": "2026-09-06T12:00:30.000Z",
  "identity": { "token": "…", "expiresAt": "2026-09-06T12:00:30.000Z" },
  "input": { "kind": "webhook", "…": "…" }
}
```

`contributionId` says which handler to run. `executionClass` is
`external_webhook` for a webhook handler and `scheduled_task` for a scheduled
task or a backfill. `attempt` starts at 1 and counts retries of the same unit of
work, and `idempotencyKey` is stable across them — the same key arriving twice
is the same work, so a handler that already finished it can say so and stop.

`deadlineAt` is when the host stops waiting. `identity.token` is the short-lived
proof you attach to host capability calls; it is bound to this installation,
this contribution, this invocation, and this execution class, and it expires at
`identity.expiresAt`.

### input by contribution kind

A webhook handler receives the delivery. The body arrives base64-encoded because
the host verified the HMAC over the exact bytes and hands you those same bytes:

```json
{
  "kind": "webhook",
  "deliveryId": "6f0f1c2d",
  "receivedAt": "2026-09-06T12:00:00.000Z",
  "headers": { "x-radioso-signature": "sha256=…" },
  "body": { "encoding": "base64", "data": "eyJldmVudCI6InB1Ymxpc2hlZCJ9" }
}
```

A scheduled task receives the occurrence it is running, plus whatever checkpoint
it returned last time:

```json
{
  "kind": "scheduled",
  "occurrenceId": "2026-09-06T12:00:00.000Z",
  "scheduledFor": "2026-09-06T12:00:00.000Z",
  "checkpoint": { "cursor": "2026-09-05T00:00:00.000Z" }
}
```

A backfill receives the request that started it and its own checkpoint:

```json
{ "kind": "backfill", "requestId": "backfill-1", "checkpoint": { "cursor": "wp_post_1204" } }
```

## The response

```json
{
  "protocolVersion": 1,
  "invocationId": "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
  "outcome": "completed",
  "output": {
    "checkpoint": { "cursor": "2026-09-06T12:00:00.000Z" },
    "counts": { "ingested": 3, "deleted": 1, "skipped": 0 }
  }
}
```

`outcome` is `completed`, `failed`, or `retry`. Anything other than `completed`
carries an `error`, and a `retry` may carry `retryAfterSeconds` to ask the host
to wait before the next attempt.

`output.checkpoint` is a JSON object the host stores and hands back on the next
invocation of the same contribution. `output.counts` reports what the run did
with documents, and the host uses it for the installation's health view.

## Host capabilities

Anything the App needs from the platform goes through the gateway. Each call
carries the invocation identity token and names one capability. What you may
call is the intersection of the manifest's `permissions`, the contribution's
`permissions`, and the grant the operator approved.

| Capability | Payload |
|---|---|
| `documents.ingest` | `document` with `externalDocumentId`, `title`, `content` (`format` of `html`, `markdown`, or `text`, plus `value`), optional `sourceUrl` and `indexedFields` |
| `documents.delete` | `externalDocumentId` |
| `storage.get` | `request` with `collection`, `key` |
| `storage.put` | `request` with `collection`, `key`, `record`, optional `expectedVersion` |
| `storage.delete` | `request` with `collection`, `key`, optional `expectedVersion` |
| `storage.query` | `request` with `collection`, `index`, `equals`, `limit`, optional `cursor` |
| `egress.fetch` | `destination`, `method`, `path`, optional `query`, `headers`, `body`, `timeoutMs` |

```json
{
  "capability": "egress.fetch",
  "destination": "site",
  "method": "GET",
  "path": "/wp-json/wp/v2/posts",
  "query": { "modified_after": "2026-09-05T00:00:00" }
}
```

`destination` is a destination id from the manifest. The host resolves the host
name — including one bound to a configuration field — attaches the credential
from the destination's connection slot, and returns the response with its body
base64-encoded. Credentials stay on the host side, so an App never holds the
secret it authenticates with.

`storage.put` and `storage.delete` take an optional `expectedVersion`. Supply
the version you read and the write only lands if nobody changed the record
underneath you; otherwise you get `version_conflict` and the stored record is
untouched.

### Capability responses

```json
{ "ok": true, "result": { "version": 2 } }
```

```json
{ "ok": false, "error": { "code": "destination_denied", "message": "host not declared" } }
```

| Code | Meaning |
|---|---|
| `denied` | The grant does not cover this call |
| `not_found` | The collection, record, or document does not exist for this installation |
| `invalid_input` | The payload does not match what the manifest declares |
| `quota_exceeded` | A declared quota or rate limit is reached |
| `version_conflict` | `expectedVersion` does not match the stored record |
| `destination_denied` | The address is outside the declared destinations |
| `deadline_exceeded` | The invocation deadline passed |
| `unavailable` | A dependency the host needs is down |
| `internal` | The host failed for a reason it cannot attribute |

The same codes appear in an invocation response's `error`.

Messages are capped at 512 characters and carry a reason, not a payload. Error
text reaches operator-visible surfaces and logs, so keep customer content,
credentials, and request bodies out of it.

## The App Job wake-up envelope

Durable work is a row in the host's job table. A queue message carries only a
pointer to it:

```json
{ "envelopeVersion": 1, "appJobId": "9c8d7e6f-1111-4222-8333-444455556666" }
```

The schema is strict: an extra key fails parsing. A consumer reads the job row
for current truth, which is what makes a wake-up that arrives twice, late, or
out of order harmless, and keeps work payloads out of the broker entirely.

## Read next

- [App Manifest Reference](./app-manifest.md) — what a contribution declares
  before any of this runs.
