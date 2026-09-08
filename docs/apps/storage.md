---
title: "Managed App Storage"
description: "How an App keeps state in Radioso: declaring collections, writing and reading records, querying by a declared index, quotas and expiry, the error codes storage returns, what a new release may change, and how an operator exports, retains, or deletes the data."
last_updated: 2026-09-08
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
Every call Radioso makes on your behalf carries the workspace and the
installation, and each one holds the installation's state row while it runs — so
a call decides whether your access still stands at the moment it takes effect,
not before it queued.

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

A field an index points at is held to a tighter bound: at most 2048 characters
and 1464 bytes. The first is the longest value `storage.query` can compare
against, so a longer one would be a record its own index could never find. The
second is what one index entry weighs: the entry carries the workspace, the
installation, the collection id, the index id, and the record key alongside the
value, and the budget left for the value is what remains after those are charged
at the longest each may be. Keep long text in an unindexed field — a `json`
payload, say — and index a short identifier beside it.

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
record's new version. Versions come from a counter the collection keeps, so every
write in a collection gets a higher number than the one before and no number is
ever handed out twice. A record you delete and write again comes back with a
version above the one it had, which is what makes the version you are holding
safe to fence with: it cannot start matching a different record later. The
counter stops at 9007199254740991, the last whole number a JSON value carries
exactly; past it two versions would round to one, so the collection refuses
further writes with `internal` rather than hand two of them the same fence.

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

A TTL is measured from each write, so touching a record renews it, and the
deadline is set from the database's own clock at the moment the row lands. A
write that waited on a lock gets the full interval it was promised rather than
what is left of it, and a read that waited is judged by the clock at the moment
it looks rather than by the one it started with.

Once the deadline passes the record is gone from every read and every query, and
its quota slot comes back with it: the very next write can use the space. A put
gives back the key it is about to write and then a bounded batch of the
collection's remaining expired rows — a capability call is not a maintenance job,
and one call may not hold the collection while it removes a million rows. Radioso
sweeps the rest on its own schedule, taking the least recently swept collections
first so a busy one cannot keep another waiting.

`storage.usage` reclaims the same bounded way and reports `reclaimPending` when
it stopped with expired rows still to remove, so a count that is ahead of the
live rows says so rather than looking simply high.
`{ "kind": "none" }` keeps records until something removes them.

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
| `denied` | The collection does not allow this operation, the installation's storage access is revoked, or its storage is deleted |
| `not_found` | A write or delete carrying `expectedVersion` found no record under that key |
| `version_conflict` | The stored record's version is not the one the call expected |
| `quota_exceeded` | The record is larger than `maxRecordBytes`, or the collection already holds `maxRecords` records |
| `unavailable` | Storage could not be reached for this call |
| `internal` | The host failed for a reason it cannot attribute to the call |

Messages name declarations you wrote in the manifest — a collection id, a
declared field key, an index id — and never a record key, a field name you
invented, or a stored value, so a message is safe to log and safe to show. A
failure inside Radioso's own storage arrives as `unavailable` or `internal`
carrying none of the underlying error, for the same reason.

## What a new release may change

Records outlive the release that wrote them, and Radioso runs no migration code
of yours over them. So a candidate release is checked before it can be activated,
and the check is a matrix rather than a comparison of two manifests. It reads
four things:

- the **candidate** declaration and the **active** one
- the declarations of **releases the operator can still roll back to**
- the **schema versions stored records actually carry**
- the **schema versions jobs already enqueued will be read back under**

The observations are per collection, because they are per collection in the
database: one collection can hold records written under version 1 while another
holds version 2, and a single list would have each answer for the other's
history. The stored versions come from Radioso's own count of what the rows
carry, not from what any release claimed.

Two independent things have to hold, and neither waives the other.

The schema rule is additive-only, in whichever direction the versions run. Of two
declarations of one collection, the one carrying the higher `schemaVersion` may
only add optional fields to the other. Removing a field, retyping one, or
changing whether it is required changes the meaning of records nobody is going to
rewrite — and no `compatibleReaderVersions` entry makes a removed field readable,
so a declaration cannot excuse it.

The reader rule is about coverage. The candidate must read everything already
there: its `compatibleReaderVersions` covers every version stored records carry
and the version the active release writes. And every reader that outlives the
activation — the active release during a rolling change, a rollback release, a
queued job — must declare the candidate's `schemaVersion` readable.

A rollback is admitted the same way. Carrying a lower `schemaVersion` than the
active release is not by itself a defect; what decides it is whether every
pairing above still holds.

That second direction is what makes dropping an old reader version legal. The
contract caps `compatibleReaderVersions` at eight entries, so a long-lived App
eventually has to drop the oldest one; it is admitted exactly when no stored
record carries that version.

A candidate may:

- add a collection
- add an optional field
- add an index, together with the rebuild below
- widen `allowedOperations`
- raise `schemaVersion`
- drop a reader version no stored record uses

A candidate is rejected when it removes a collection, removes a field, changes a
field's type, makes an optional field required **or** a required field optional,
adds a required field, removes an index, moves an index to a different field,
narrows `allowedOperations`, or lowers `schemaVersion`. Each of these changes the
meaning of records nobody is going to rewrite: a retyped field makes stored
values unreadable, a newly required field makes every existing record invalid, a
newly optional one makes a field an older reader still requires disappear, a
removed index takes away the only access path a queued job may have been planned
against, and a narrowed operation list turns that job's next call into `denied`.

**An added index is built before the release serves a query.** An index entry
exists per record, so a new index answers nothing about records earlier releases
wrote. The compatibility report names each added index as a rebuild, and
activation runs it over the collection in batches. Until it finishes, a query by
that index would return part of the collection and look correct doing it.

The rebuild runs beside ordinary writes rather than stopping them. The index is
marked pending on the installation before the first batch, and while that mark is
set every write maintains an entry for it — including a write from a release that
does not declare the index at all. A closing pass then covers the records written
since the mark went up, which is what catches anything that landed behind the
batch cursor. A value stored before its field was indexed was never measured
against the indexed-value bound, so a rebuild that meets one reports it with a
count rather than activating a release whose query would silently skip those
records.

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
  the App held. Whether the export may run is answered before a record is read,
  so an installation that is already deleted is refused rather than handed an
  empty file; and the whole stream reads one database state, so a record written
  or removed while it runs is wholly in the export or wholly out. A failure
  part-way through ends the stream with an error rather than with what looks like
  the end of the data.
- **Retain until a date** holds the data for a bounded period, for a support
  investigation or a compliance window. Retained data is data the App may no
  longer reach, so setting a deadline takes the installation's storage access
  away in the same transaction when it is not already revoked. The date is a real
  instant in the future, at most 90 days out; Radioso deletes the installation's
  data when it passes, in one transaction, and records the counts it removed. The
  deadline is rechecked while the installation is held, so extending a hold at the
  last moment keeps the data rather than losing it to a decision made a moment
  earlier. A hold you set is a hold that ends.
- **Delete** removes the installation's records, its index entries, and its usage
  accounting, and leaves a marker in place of the installation. Every later call
  against it — a read, a write, an export, another retention — answers `denied`, so
  a call that was already in flight when you deleted cannot put a record back.
  Deleting again is the exception: it answers with the counts the first deletion
  committed, because a caller whose response was lost to a crashed process or a
  retried job has to be able to ask what became of the data. The marker goes when
  the workspace does.

**Deleting a workspace deletes its App storage.** Every installation's records go
with it, through the same cascade that covers the rest of the workspace's data.
There is no second path that removes them, because one would only race the first.

Each of these leaves an audit event in the `app.data.*` family — export
requested, completed, or cancelled; retention changed; deletion requested and
completed. The event is written by the same transaction as the change it
describes, so the trail cannot name a deletion that rolled back or miss one that
committed; publishing it onto the audit spine happens afterwards, which is why a
result never reports a failure for an effect that already landed. The events
carry the workspace, the installation, and counts. An
export whose consumer stopped part-way is recorded as cancelled with what had
been handed over, a retention date outside policy as a failed change, and a
deletion that did not finish as a failed deletion — because a trail that shows
only the successful half cannot answer where the data went. They do not carry
record keys or stored values, because the point of the trail is to show that a
disposition happened, not to become a second copy of what was in it.

## Common failure modes

**Every write comes back `invalid_input`.** The record carries a key the
collection does not declare, a field key is not lower-case snake case, or a field
an index points at is past the indexed-value bound above.

**A query returns nothing though the records are there.** Check that the record
actually carries the indexed field. A record that omits an optional indexed field
produces no index entry, so it cannot match a query on that index. If the index
is one your release added, the records written before it exist under it only once
the rebuild that activation runs has covered them.

**A put returns `version_conflict` on every retry.** Something else is writing
the same key in a loop. Re-read the record on each attempt rather than reusing
the version you first read.

**Records disappear sooner than expected.** The collection declares a TTL, and
the TTL runs from the last write, not from the first.

## Read next

- [App Manifest Reference](app-manifest.md) — where `storageCollections` sits in the manifest
- [App Runtime Protocol](runtime-protocol.md) — the exact request and result shapes for `storage.get`, `storage.put`, `storage.delete`, and `storage.query`
