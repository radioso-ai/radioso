---
title: "Managed App Storage"
description: "How an App keeps state in Radioso: declaring collections, writing and reading records, querying by a declared index, quotas and expiry, the error codes storage returns, what a new release may change, and how an operator exports, retains, or deletes the data."
last_updated: 2026-09-07
---

# Managed App Storage

Most Apps need somewhere to remember a little state between runs: which page
they synced last, which external id maps to which document, where a backfill got
to. Standing up a database for that is a lot of machinery for a few kilobytes,
and it puts customer data somewhere the operator cannot see.

Managed App Storage is Radioso's answer. You declare collections in your
manifest; Radioso keeps the rows, inside the workspace, under the installation
that wrote them. You never write SQL, never run a migration, and never see a
table. What you get back is a small key/value store with typed records, one
index per query you need, and quotas the operator approved when they installed
you.

It is deliberately small. Complex relational data, anything high-volume, and
anything you share with systems outside Radioso belongs in your own storage,
reached through a declared egress destination — and disclosed to the operator as
such.

## Declaring a collection

A collection is a manifest declaration. Radioso reads it at install and enforces
it on every call:

```json
{
  "id": "sync_state",
  "scope": "installation",
  "schemaVersion": 1,
  "compatibleReaderVersions": [1],
  "recordSchema": {
    "fields": [
      { "key": "external_id", "type": "string", "required": true },
      { "key": "sequence", "type": "number", "required": false },
      { "key": "payload", "type": "json", "required": false }
    ]
  },
  "indexes": [{ "id": "by_external_id", "field": "external_id" }],
  "quotas": { "maxRecords": 5000, "maxRecordBytes": 8192 },
  "retention": { "kind": "none" },
  "allowedOperations": ["get", "put", "delete", "query_by_index"]
}
```

Collection ids, field keys, and index ids are lower-case snake case, one to 64
characters.

`scope` is `installation`. Two installations of the same App in the same
workspace hold two separate sets of records, and a key that exists in both is
two different records. An installation asking for a key it never wrote gets
`{ "record": null }`, whatever another installation stores under that name.

## The record schema

Every field you intend to store is declared with a `key`, a `type`, and whether
it is `required`. The five types are:

| Type | What a record carries |
|---|---|
| `string` | A JSON string, at most 8192 characters |
| `number` | A finite JSON number |
| `boolean` | `true` or `false` |
| `timestamp` | An ISO-8601 string, such as `2026-09-07T10:00:00.000Z` |
| `json` | Any JSON value, within the protocol's depth, breadth, and size bounds |

A write is checked against that list before anything is stored. A missing
required field, a value of the wrong type, and a key you never declared are all
`invalid_input`. There is no partial write: a record that fails validation
leaves the stored record exactly as it was.

Size is checked the same way. A record that serializes past the collection's
`maxRecordBytes` comes back as `quota_exceeded`, and `maxRecordBytes` itself
stops at 65536 — the ceiling every message on the runtime protocol shares, so a
collection can never promise capacity the wire refuses to carry.

## Reading and writing

The four operations are host capability calls, described in full in the
[App Runtime Protocol](runtime-protocol.md). In summary:

`storage.get` takes a collection and a key and answers with the record or
`null`.

`storage.put` takes a collection, a key, and a record, and answers with the
record's new version. Versions start at 1 and increase by one per write.

`storage.delete` takes a collection and a key and answers with whether it
removed anything. Deleting a key that is not there succeeds, having deleted
nothing.

`storage.query` takes a collection, an index, a value to match, and a page size.
It answers with the matching records in key order, and a cursor when more remain.

### Writing safely against concurrent runs

Two invocations of your App can be in flight at once — a scheduled run and a
webhook delivery, say — and both may want the same key. Pass `expectedVersion`
on a put or a delete to make the write conditional on the version you read:

```json
{ "collection": "sync_state", "key": "post_41", "record": { "external_id": "41" }, "expectedVersion": 3 }
```

If the stored record has moved on, the write does nothing and returns
`version_conflict`. Read the record again, decide what the merged state should
be, and retry. If no record exists under that key at all, a fenced write returns
`not_found` rather than creating one.

## Querying by an index

Storage answers one shape of query: equality on a single declared index. Declare
an index for each lookup you need, on a `string`, `number`, `boolean`, or
`timestamp` field — a `json` field cannot carry one, because an index compares
one value per key.

```json
{ "collection": "sync_state", "index": "by_external_id", "equals": "41", "limit": 50 }
```

The comparison happens in the indexed field's own type. An index on a number is
compared as a number, so `10` sorts after `9` rather than before it, and passing
a string to a numeric index is `invalid_input` rather than a silent miss.

Page size is between 1 and 200, and defaults to 50. When more records match than
the page holds, the result carries a `cursor`; pass it back on the next call to
resume. Treat it as opaque. Results come back in key order, so a record written
while you page does not shift the rows you already read.

An index entry follows its record. Rewriting the indexed field moves the record
out of the group it used to match, and deleting a record takes its index entries
with it.

## Quotas

`maxRecords` is the number of keys a collection holds for one installation, and
`maxRecordBytes` is the ceiling on one record. Rewriting a key already stored
consumes no new slot, and deleting a record returns one, so the record count is a
ceiling rather than a ratchet. A put that would take the collection past
`maxRecords` returns `quota_exceeded` and stores nothing.

Set both to what your App actually needs. The operator sees them at install and
they are part of what they approve.

## Expiry

`retention` decides how long a record lives:

```json
{ "kind": "ttl", "seconds": 86400 }
```

A TTL is measured from each write, so touching a record renews it. Once the
deadline passes the record is gone from every read and every query immediately —
Radioso reclaims the row on its own schedule, but nothing you can observe depends
on when that happens. `{ "kind": "none" }` keeps records until something removes
them.

## Allowed operations

`allowedOperations` is your own statement of what you do with a collection, and
the operator approves it at install. A collection declared `["get", "put"]`
refuses a delete with `denied`, even though your App holds the storage
permission. Declare the operations you use and no more: it is the clearest
signal an operator gets about what the collection is for.

## Error codes

Storage answers a failed call with one of these:

| Code | What happened |
|---|---|
| `invalid_input` | The collection is not one this installation declares, the record does not match its schema, or the query names an index or a value type the collection does not have |
| `denied` | The collection does not allow this operation, or the installation's storage access is revoked |
| `not_found` | A write or delete carrying `expectedVersion` found no record under that key |
| `version_conflict` | The stored record's version is not the one the call expected |
| `quota_exceeded` | The record is larger than `maxRecordBytes`, or the collection already holds `maxRecords` records |
| `unavailable` | Storage could not be reached for this call |
| `internal` | The host failed for a reason it cannot attribute to the call |

Messages name declarations — a collection id, a field key, an index id — and
never a record key or a stored value, so a message is safe to log and safe to
show.

## What a new release may change

Records outlive the release that wrote them, and Radioso runs no migration code
of yours over them. So a candidate release is checked against the active one
before it can be activated, and the policy is additive.

A candidate may:

- add a collection
- add an optional field
- add an index
- widen `allowedOperations`
- raise `schemaVersion`, as long as `compatibleReaderVersions` still lists every
  version the active release declared

A candidate is rejected when it removes a collection, removes a field, changes a
field's type, makes an existing optional field required, adds a required field,
removes an index, moves an index to a different field, lowers `schemaVersion`, or
drops a reader version the active release supported. Each of these changes the
meaning of records nobody is going to rewrite: a retyped field makes stored
values unreadable, a newly required field makes every existing record invalid,
and a removed index takes away the only access path a queued job — which keeps
the schema version it was enqueued under — may have been planned against.

The practical shape of a schema change is therefore: add the new field as
optional, write both fields for a release, and stop reading the old one. The old
field stays declared.

## For operators: export, retention, and deletion

Managed App data is workspace data, and you decide what happens to it.

**Disabling or quarantining an App revokes its storage access and deletes
nothing.** Every read and write from that installation returns `denied` while it
is disabled; the records stay exactly as they were, and re-enabling the App
restores access to them. This is the safe way to stop an App you are unsure
about.

**Removing an App requires you to choose what happens to its data.** There are
three dispositions:

- **Export** streams every record the installation holds as JSON Lines, one line
  per record, grouped by collection. Each line carries the collection id, the
  key, the version, the schema version, the last-updated timestamp, and the
  record itself — enough to reload it elsewhere or keep it as a record of what
  the App held.
- **Retain until a date** holds the data for a bounded period, for a support
  investigation or a compliance window, without leaving the App able to reach it.
- **Delete** removes the installation's records, its index entries, and its usage
  accounting.

**Deleting a workspace deletes its App storage.** Every installation's records go
with it, through the same guarantee that covers the rest of the workspace's data.

Each of these leaves an audit event in the `app.data.*` family — export
requested and completed, retention changed, deletion requested and completed.
The events carry the workspace, the installation, and counts. They do not carry
record keys or stored values, because the point of the trail is to show that a
disposition happened, not to become a second copy of what was in it.

## Common failure modes

**Every write comes back `invalid_input`.** The record carries a key the
collection does not declare, or a field key is not lower-case snake case. The
message names the field.

**A query returns nothing though the records are there.** Check that the record
actually carries the indexed field. A record that omits an optional indexed field
produces no index entry, so it cannot match a query on that index.

**A put returns `version_conflict` on every retry.** Something else is writing
the same key in a loop. Re-read the record on each attempt rather than reusing
the version you first read.

**Records disappear sooner than expected.** The collection declares a TTL, and
the TTL runs from the last write, not from the first.

## Read next

- [App Manifest Reference](app-manifest.md) — where `storageCollections` sits in the manifest
- [App Runtime Protocol](runtime-protocol.md) — the exact request and result shapes for `storage.get`, `storage.put`, `storage.delete`, and `storage.query`
