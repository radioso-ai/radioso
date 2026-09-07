---
title: "App Runtime Protocol"
description: "The wire contract between a Radioso host and an App: invocation requests and responses per input kind, host capability calls, error codes, and the App Job wake-up envelope."
last_updated: 2026-09-07
---

# App Runtime Protocol

An App runs as its own program. The host sends it invocations; it answers with
an outcome and calls back for anything it needs from the platform. Both
directions are JSON, both are schema-checked at the boundary, and both are
versioned by `protocolVersion: 1`.

The schemas are in `@radioso/app-contract`, so a host, an App, and the
conformance harness all validate the same bytes the same way.

## Readiness

Before the host sends any work, it asks the artifact what it is:

```json
{ "protocolVersion": 1, "ready": true, "implementedContributionIds": ["site_content", "content_push"] }
```

## An invocation

The host sends one request per unit of work:

```json
{
  "protocolVersion": 1,
  "invocationId": "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
  "installationId": "1d2e3f40-1111-4222-8333-444455556666",
  "releaseDigest": "sha256:1f0c…",
  "contributionId": "content_push",
  "executionClass": "external_webhook",
  "inputSchemaVersion": 1,
  "attempt": 1,
  "idempotencyKey": "delivery:6f0f1c2d",
  "deadlineAt": "2026-09-06T12:00:30.000Z",
  "capabilitySession": { "token": "…", "expiresAt": "2026-09-06T12:00:30.000Z" },
  "context": { "configuration": { "site_url": "https://example.com", "post_types": "page,post" } },
  "input": { "kind": "webhook", "…": "…" }
}
```

`contributionId` says which handler to run. `releaseDigest` and
`inputSchemaVersion` say which release and which input shape the work was queued
against, so an old job leased while a candidate release is under test resolves
to one answer rather than a guess.

`executionClass` is `external_webhook` for a webhook handler and
`scheduled_task` for a scheduled task or a backfill, and it has to match
`input.kind`: `external_webhook` carries `webhook`, `scheduled_task` carries
`scheduled` or `backfill`. A request that pairs them any other way fails at the
boundary.

`attempt` starts at 1 and counts retries of the same unit of work, and
`idempotencyKey` is stable across them — the same key arriving twice is the same
work, so a handler that already finished it can say so and stop.

`deadlineAt` is when the host stops waiting. `capabilitySession.token` is the
short-lived handle you attach to host capability calls; it is bound to this
installation, this contribution, this invocation, and this execution class, and
it expires at `capabilitySession.expiresAt`.

The gateway supplies all of this. An App cannot select a different installation,
contribution, schema, deadline, or capability set.

### Installation context

`context.configuration` is the effective configuration. It holds every required
value field, every value field that declares a default, and every optional field
the operator supplied a value for. It never holds a `connection_slot` field:
those keep their value in the slot, and no invocation carries credential
material. A value is a string of up to 4 096 characters, a finite number, or a
boolean, and the map holds at most 64 entries. It arrives on every invocation, so
a handler never has to discover which post types, which folder, or which locale
an installation meant.

A field that is optional and declares no default is the one gap to code against:
read it as `configuration["author_filter"] ?? "all"` rather than expecting a key
for every field the manifest declares.

Effective means resolved, and the order is fixed: resolve, then validate, then
deliver. The gateway starts from what the operator stored, which is sparse —
a field left alone has no stored value. It bounds that map, copies it,
materializes every declared default, and validates the map that results: every
required field present, every value the type its field declares, numbers inside
`min` and `max` and inside the interval range of any schedule that reads them,
`select` values among their options, `url` values parseable, inside the protocols
of any destination they back and on a port those destinations permit, and no
undeclared keys. Only then does it mint the invocation.

`resolveInstallation(manifest, storedValues)` in `@radioso/app-contract` is that
one operation, and it is the only door: it returns the effective configuration
and the readiness answer together, so a dashboard, an installation plan, and the
gateway reach the same map and the same list of active contributions. The
configuration it returns is frozen and carries a brand the package does not
export, so a stored map cannot be spelled as a resolved one and a resolved one
cannot be edited after the fact — an interval a caller lowered to 30 seconds
after resolution is exactly the failure that pairing prevents.

A schedule-bound field is always present. Admission refuses a manifest whose
`interval_from_configuration` schedule reads a field an installation could leave
empty, so a scheduled task that is active always has a whole number of seconds to
run on.

`resolveInstallation` accepts only the admitted manifest `validateManifest`
returns, not any manifest that merely parses. Admission is one boundary rather
than two: a manifest `validateManifest` would refuse — a schedule bound to a
field that is not a required or defaulted number, a destination host bound to
a field that is not a `url` field — can never reach readiness, because
`resolveInstallation` checks the manifest against runtime admission identity
before using it, not only its type. A host that stores a manifest re-runs
`validateManifest` on load to regain the admitted value; it never persists or
reconstructs the admitted type directly.

The admitted value is deeply frozen and typed transitively `readonly`, down to
every nested array and object rather than only the top level, so a nested
mutation attempt is both a type error and a runtime `TypeError`. Spreading an
admitted manifest produces a plain, unfrozen copy that still types as
admitted — TypeScript carries the phantom brand through a spread — but that
copy is not the object `validateManifest` returned, so `resolveInstallation`
rejects it with an `unadmitted_manifest` issue instead of trusting it. A
caller passes the admitted value itself to `resolveInstallation`, never a
spread of it.

An issue it reports names a key only when the manifest declares that key.
Anything else is addressed by its position in the stored map — `configuration.3`
— so a stored key an attacker chose never reaches a log or an audit record.

Nothing here is a secret. Configuration has no secret field type: credential
material lives in a connection slot, and the broker attaches it server-side on
the way out. An App holds no credential at any point. A destination id is your
App's only handle to a connection — you name a destination on an `egress.fetch`
call, and the broker resolves the address from configuration and attaches the
credential the manifest bound to it.

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
  "outcome": "succeeded",
  "outputSchemaVersion": 1,
  "output": { "counts": { "ingested": 3, "deleted": 1, "skipped": 0 } },
  "checkpoint": { "cursor": "2026-09-06T12:00:00.000Z" }
}
```

`outcome` is a closed catalog, and what a response may carry follows from it:

| `outcome` | Means | Carries |
|---|---|---|
| `succeeded` | The work is done | `outputSchemaVersion`, `output`, optional `checkpoint` |
| `retryable_failure` | Worth another attempt | `error`, optional `retryAfterSeconds` and `checkpoint` |
| `rate_limited` | A dependency is throttling | `error`, optional `retryAfterSeconds` and `checkpoint` |
| `unavailable` | A dependency is down | `error`, optional `retryAfterSeconds` and `checkpoint` |
| `invalid_request` | The App could not read the request | `error` |
| `denied` | The App refused the work | `error` |
| `terminal_failure` | Over, and another attempt changes nothing | `error` |
| `timed_out` | The deadline passed | `error` |
| `cancelled` | The work was called off | `error` |

The arms are mutually exclusive: a success cannot carry an error, and an outcome
that is over cannot carry a checkpoint or a retry hint nothing would read.

`checkpoint` is a JSON object the host stores and hands back on the next
invocation of the same contribution. `output.counts` reports what the run did
with documents, and the host uses it for the installation's health view;
everything else under `output` is yours, bounded rather than interpreted.

Bounds apply to every free-form value: at most 8 levels of nesting, 256 keys per
object, 1 024 array items, 8 192 characters per string, and 64 KiB serialized.
The serialized bound is measured over the whole value, not over each of its
members, so `output` as a whole stays under 64 KiB however many keys it carries.
An oversized value is refused at the first violation, without the host ever
serializing it, and an object wider than 256 keys is refused before its values
are read at all.

Send plain JSON containers: object literals and arrays, holding strings, finite
numbers, booleans, and `null`. A `Date`, a `Map`, a class instance, a typed
array, an object with a `toJSON` method, and a property backed by a getter are
all refused, because what the host measures has to be what the host writes — an
object that decides its own serialized form serializes to something no bound
ever saw. Convert before you answer: `publishedAt: date.toISOString()`,
`items: [...map.values()]`.

Serialized size is counted the way JSON writes the value. A surrogate pair is one
character in four UTF-8 bytes; an unpaired surrogate has no encoding, so JSON
writes it as a six-character `\uXXXX` escape and it costs six bytes here.

## Host capabilities

Anything the App needs from the platform goes through the gateway, in one
envelope:

```json
{
  "protocolVersion": 1,
  "invocationId": "8b1f6f2a-6f6f-4a3f-9c4a-2f0d0f8a1b21",
  "capabilitySession": "…",
  "requestId": "wp_post_4211:2026-09-02T09:15:00",
  "request": { "capability": "storage.get", "request": { "collection": "sync_state", "key": "site" } }
}
```

`capabilitySession` is the token from the invocation request, which is what
authenticates the call. `requestId` is yours to choose and has to stay the same
across every retry of one logical effect — that is what lets a deduplicating
capability recognise the second delivery as the first. What you may call is the
intersection of the manifest's `permissions`, the contribution's `permissions`,
and the grant the operator approved.

| Capability | Payload |
|---|---|
| `documents.ingest` | `sourceContributionId`, and `document` with `externalDocumentId`, `title`, `content` (`format` of `html`, `markdown`, or `text`, plus `value`), optional `sourceUrl`, `indexedFields`, `metadata`, `publishedAt`, `modifiedAt`, `author` |
| `documents.delete` | `sourceContributionId`, `externalDocumentId` |
| `storage.get` | `request` with `collection`, `key` |
| `storage.put` | `request` with `collection`, `key`, `record`, optional `expectedVersion` |
| `storage.delete` | `request` with `collection`, `key`, optional `expectedVersion` |
| `storage.query` | `request` with `collection`, `index`, `equals`, `limit`, optional `cursor` |
| `egress.fetch` | `destination`, `method`, `path`, optional `query`, `headers`, `body`, `timeoutMs` |

`sourceContributionId` names the `document_source` contribution the write
belongs to. That is how the host knows whose external-id namespace and
indexed-field vocabulary an effect uses, and it is what the host attaches
provenance from — provenance is the host's to write, never yours.

The gateway holds a document effect to four rules, in this order:

1. It derives the invoking contribution from the authenticated capability
   session, never from anything in the request.
2. `sourceContributionId` must appear in that contribution's `documentSources`,
   or equal the invoking contribution itself when a `document_source` is running
   its own backfill. Anything else is `denied`.
3. It enforces that source's `externalIdNamespace` and its `indexedFields`
   policy: a key outside a `declared` list, or more keys than a `dynamic` policy
   allows, is `invalid_input`.
4. It writes installation, release, and source provenance itself.

That is why a contribution asking for a document permission has to name at least
one source at admission: a handler with an empty list could never satisfy rule 2.

`indexedFields` carries the values a retrieval rule compares: one scalar per
key, under keys the source's `indexedFields` policy allows. `metadata` carries
the rest of what the source knows about the document — up to 64 keys, each a
string of up to 1 024 characters, a number, or a boolean.

```json
{
  "capability": "egress.fetch",
  "destination": "site",
  "method": "GET",
  "path": "/wp-json/wp/v2/posts",
  "query": { "modified_after": "2026-09-05T00:00:00" }
}
```

`destination` is a destination id from the manifest, and it is your App's only
handle to a connection: you never see an address or a credential. `path` is
origin-relative: exactly one leading slash, and no scheme, authority, backslash,
query, or fragment. A path that could resolve to another host is refused here
rather than by whatever resolves it later.

A destination bound to a configuration field is an origin prefix, and `path` is
appended below it, so `path` is held to one canonical spelling. Every `%`
introduces two hex digits, and no escape spells a separator, a percent, or a
control character: `%2F`, `%5C`, `%25`, and the encodings of 0x00-0x1F and 0x7F
are refused, as are those characters written literally. What is left decodes
exactly once, as UTF-8 and no other way, and no segment of the result may be `.`
or `..`. That makes `/../wp-admin`, `/%2e%2e/wp-admin`, `/%2e%2e%2fwp-admin`,
`/%252e%252e/wp-admin`, and `/wp%2f..%2fadmin` the same refusal: each is how a
path climbs back above the prefix the operator entered while every later check
still reports it as inside.

The decoder is strict, so a path has one meaning rather than one per hop. An
invalid percent sequence such as `/wp-json/%FF`, an overlong encoding such as
`/wp-json/%C0%AE%C0%AE/admin` — a historical spelling of `..` — and an unpaired
UTF-16 surrogate are all refused, because each is something one transport rejects
and the next replaces or normalizes into a different path. Valid UTF-8 passes:
`/wp-json/wp/v2/posts`, `/wp-json/caf%C3%A9`, and `/wp-json/a%20b` are all
reachable, because a space and an accented character are not separators.

Put the whole address you mean in `path` and the parameters in `query`; a `?`
inside `path` is refused, because a query that arrives that way is a query that
never met the bounded `query` field.

`query` carries at most 64 entries and encodes to at most 8 KiB. The broker
builds the query as `application/x-www-form-urlencoded`, exactly as
`URLSearchParams` serializes it, and the ceiling is measured in that encoding: one
`=` inside every pair, one `&` between pairs, and each name and value encoded the
way that serializer encodes it. A query whose encoding is exactly 8 192 bytes
passes. A key or value holding an unpaired surrogate is not encodable text and is
refused, and the entry count is settled before any of it is measured.

`headers` carries what your App needs and nothing the broker owns. The broker
refuses `host`, `content-length`, `transfer-encoding`, `connection`, `upgrade`,
`te`, `trailer`, `keep-alive`, `proxy-authorization`, `proxy-connection`, and
`proxy-authenticate`, matched without regard to case; it refuses `authorization`;
and it refuses any header equal to the destination's own declared credential
header, then injects exactly one host-owned value in its place.

`query`, `headers`, `metadata`, `indexedFields`, and an installation's stored
configuration are all read the same way: as plain objects carrying their own data
properties. A map whose entry is backed by a getter, or whose key comes from its
prototype rather than from itself, is refused before any value is read — the host
never runs a caller's accessor to find out whether a map is acceptable, and never
walks a key the map does not carry. What passes is copied into a fresh map with
no prototype, so what the rest of the pipeline reads is exactly what was
validated.

A header value is an HTTP field value: tab, space, visible ASCII, and obs-text.
A carriage return, a line feed, a NUL, a DEL, or anything above one byte — an
emoji, say — is refused at the boundary, where an App gets a clear answer,
rather than by whichever client meets it first. The same rule holds for the
headers a response brings back. Percent-encode or base64 anything else you need
to carry.

`GET` and `HEAD` carry no `body`. Node's own `Request` refuses one, so a request
that declares it is a request the broker cannot make.

The host resolves the address — including one bound to a configuration field,
where the operator's URL is an origin prefix and `path` is appended below it —
on a protocol and port the destination declares: a destination that lists no
`ports` reaches the default port of each protocol it declares, 443 on `https` and
80 on `http`, and one that lists `ports` reaches exactly those. It applies the
destination's declared credential, and returns the response with its
body base64-encoded. The manifest says which slot to draw from and what to build:
HTTP Basic from a username and password field, a bearer token from one field, or
a named header carrying one field. When the destination's credential is not
`required` and the slot is unbound, the broker sends the request anonymously. A
body in either direction is real base64 and decodes to at most 4 MiB.
Credentials stay on the host side, so an App never holds the secret it
authenticates with.

`storage.put` and `storage.delete` take an optional `expectedVersion`. Supply
the version you read and the write only lands if nobody changed the record
underneath you; otherwise you get `version_conflict` and the stored record is
untouched.

### Capability responses

A success names the capability, and the capability fixes the result's shape:

```json
{ "ok": true, "capability": "storage.put", "result": { "version": 2 } }
```

| Capability | `result` |
|---|---|
| `documents.ingest` | `externalDocumentId`, and `outcome` of `created`, `updated`, or `unchanged` |
| `documents.delete` | `deleted` |
| `storage.get` | `record`, or `null` |
| `storage.put` | `version` |
| `storage.delete` | `deleted` |
| `storage.query` | `records`, optional `cursor` |
| `egress.fetch` | `status`, `headers`, `body` base64-encoded |

A failure carries an error and nothing else:

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
