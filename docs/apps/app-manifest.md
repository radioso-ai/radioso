---
title: "App Manifest Reference"
description: "Every section of a Radioso App manifest: identity, artifact, permissions, configuration, connections, destinations, storage collections, contributions, setup guide, and the issue codes validation returns."
last_updated: 2026-09-06
---

# App Manifest Reference

A manifest is the whole of what a host knows about your App before it runs. It
declares who you are, what your program needs, what an operator has to fill in,
where you are allowed to send bytes, and which contributions you offer. The host
reads it once at admission, shows the operator a plan built from it, and
enforces it for the life of the installation.

Manifests are JSON. The schemas and the validator live in
`@radioso/app-contract`, so the same rules apply in the dashboard, in the
gateway, and in a conformance run.

```json
{
  "manifestSchemaVersion": 1,
  "runtimeProtocolVersion": 1,
  "app": {
    "id": "ai.radioso.wordpress",
    "name": "WordPress",
    "description": "Keeps a workspace in step with a WordPress site.",
    "publisher": { "id": "ai.radioso", "name": "Radioso" }
  },
  "version": "1.0.0",
  "radiosoCompatibility": ">=0.1.0",
  "artifact": {
    "digest": "sha256:1f0c…",
    "mediaType": "application/vnd.radioso.app.node-bundle.v1+tar",
    "entrypoint": "dist/main.js"
  }
}
```

## Identifiers and versions

`manifestSchemaVersion` is `1`. Any other value fails parsing, which is what
keeps a host from half-reading a manifest written against a different schema.

`runtimeProtocolVersion` is `1`: the wire protocol your artifact implements. It
moves independently of the manifest schema, so admission establishes that the
program speaks a protocol this host still runs before it sends any work.

Every object in a manifest is strict. An undeclared key fails parsing rather
than being dropped, because a declaration the operator approves and the host
ignores is worse than one it refuses.

`app.id` and `app.publisher.id` are lower-case reverse-DNS names such as
`ai.radioso.wordpress`. Everything else you name — contribution ids, collection
ids, connection slot ids, destination ids, index ids, configuration keys,
storage field keys — shares one shape: lower-case, starting with a letter,
letters, digits, and underscores, up to 64 characters.

Indexed-field keys are the exception, because you do not own them: they come
from the system you sync, where a `SKU` or an `ISBN` is spelled the way that
system spells it. They start with a letter and hold letters, digits, and
underscores in any case, up to 64 characters.

`version` is a semantic version. `radiosoCompatibility` is a semantic version
range such as `>=1.0.0` or `^1.2.0 || ^2.0.0`; the host checks its own version
against it at admission.

Digests are `sha256:` followed by 64 lower-case hex characters.

## artifact

How your program is shipped.

| Field | Meaning |
|---|---|
| `digest` | Content digest of the artifact. The host verifies it before running anything. |
| `mediaType` | `application/vnd.radioso.app.node-bundle.v1+tar` for a Node bundle, `application/vnd.oci.image.manifest.v1+json` for an OCI image. |
| `entrypoint` | Optional path inside the bundle, such as `dist/main.js`. |

## permissions

The host capabilities your App may hold a grant for:

- `documents.ingest` — write a document into the workspace
- `documents.delete` — remove one it wrote
- `storage.read`, `storage.write` — use your declared collections
- `egress.fetch` — make a request to a declared destination

A contribution's `permissions` must be a subset of the manifest's, and the
manifest's must be a subset of what the host offers. Ask for the narrowest set
that works: the operator sees this list on the grant screen before installing.

## configuration

What the operator fills in. Each field:

```json
{
  "key": "poll_interval_sec",
  "type": "number",
  "label": "Polling interval in seconds",
  "description": "0 leaves the companion plugin to push changes.",
  "required": false,
  "default": 0,
  "min": 0
}
```

Every field carries `key`, `label`, `required`, and optionally `description` and
`placeholder`. `type` decides the rest, and each type accepts only what that
type can mean:

| `type` | Carries |
|---|---|
| `text`, `url` | Optional `default`, a string |
| `number` | Optional `default`, `min`, and `max`, all numbers; `max` is at least `min` |
| `boolean` | Optional `default`, a boolean |
| `select` | `options` with a `value` and a `label` each, and an optional `default` that is one of those values |
| `connection_slot` | `connectionSlot`, the id of a slot declared under `connections`, and no `default` |

A `number` field cannot default to a word, and a `connection_slot` field carries
no default at all. Credential material belongs in the slot, which is why there
is no secret field type here: configuration values are visible to the operator,
appear in the installation plan, and are readable by your App.

## connections

Where credential material lives. The host stores the value; your App gets a
reference and the gateway attaches the credential server-side.

A `secret_fields` slot collects values from the operator. Each field says
whether it is `sensitive`, which decides whether the dashboard ever shows it
again:

```json
{
  "id": "site_credentials",
  "kind": "secret_fields",
  "displayName": "WordPress site credentials",
  "fields": [
    { "key": "wp_username", "label": "Username", "sensitive": false, "required": true },
    { "key": "wp_application_password", "label": "Application password", "sensitive": true, "required": true }
  ]
}
```

A `generated_secret` slot has the host mint the value and show it to the
operator once — the shape to use for a webhook signing secret. `byteLength`
defaults to 32.

An `oauth2` slot parses, and a Release A host returns
`unsupported_connection_kind` for it.

## destinations

Every network address your App may reach, and nothing else is reachable. A host
is either a pattern you know when you publish, or a configuration field the
operator fills in:

```json
{
  "id": "site",
  "host": { "kind": "configuration", "field": "site_url" },
  "protocols": ["https", "http"],
  "purpose": "Read published content from the configured WordPress site.",
  "dataClasses": ["credentials"],
  "connectionSlot": "site_credentials"
}
```

A configuration-bound host must name a `url` field. That is what lets one
release serve many sites without one installation reaching another's.

`protocols` holds `https`, `http`, or both. `http` is here because a self-hosted
site reachable only over plain HTTP is a real installation; declaring it puts it
on the operator's grant screen, one destination at a time.

`ports` is optional. `purpose` is the sentence the operator reads on the grant
screen. `dataClasses` says what leaves the platform on this destination — `document_content`, `document_metadata`,
`installation_configuration`, `credentials`, or `operational_metadata`.
`connectionSlot` names the credential the gateway attaches.

## storageCollections

Radioso keeps the rows; you declare the shape. Every collection is scoped to one
installation inside one workspace, so a key that exists in two installations is
two different records.

```json
{
  "id": "sync_state",
  "scope": "installation",
  "schemaVersion": 1,
  "compatibleReaderVersions": [1],
  "recordSchema": {
    "fields": [
      { "key": "cursor", "type": "string", "required": true },
      { "key": "updated_at", "type": "timestamp", "required": true }
    ]
  },
  "indexes": [{ "id": "by_updated_at", "field": "updated_at" }],
  "quotas": { "maxRecords": 100, "maxRecordBytes": 8192 },
  "retention": { "kind": "none" },
  "allowedOperations": ["get", "put", "delete", "query_by_index"]
}
```

Field types are `string`, `number`, `boolean`, `timestamp`, and `json`. An index
compares one value per key, so it can only sit on a `string`, `number`,
`boolean`, or `timestamp` field. `compatibleReaderVersions` must include
`schemaVersion`. `retention` is `{ "kind": "none" }` or
`{ "kind": "ttl", "seconds": 86400 }`. `allowedOperations` is the subset of
`get`, `put`, `delete`, and `query_by_index` the host accepts.

## contributions

A contribution is one thing your App does. Every contribution carries the same
header:

| Field | Meaning |
|---|---|
| `id` | Stable id; the host addresses invocations by it |
| `kind` | Which of the kinds below |
| `displayName`, `description` | What the operator reads |
| `permissions` | Subset of the manifest's permissions this contribution uses |
| `egressDestinations` | Ids of destinations this contribution may reach |
| `deadlineMs` | Wall-clock budget for one invocation, 1 000 to 900 000 |
| `availability` | `required` if the installation is broken without it, otherwise `optional` |
| `inputSchemaVersion` | Which input shape this contribution reads, a positive integer |
| `outputSchemaVersion` | Which output shape it writes, a positive integer |

Input and output shapes version independently of the release, so a queued job
says which shape it was written against and a host refuses one it cannot read
rather than half-reading it.

### document_source

Content your App publishes into the workspace.

| Field | Meaning |
|---|---|
| `externalIdNamespace` | Prefix for the external ids you write, such as `wp_post` |
| `syncModes` | Any of `push`, `poll`, `backfill` |
| `contentFormats` | Any of `html`, `markdown`, `text` |
| `indexedFields` | Who owns the keys this source indexes, below |
| `backfill` | Optional `{ "checkpointCollection": "sync_state" }` |

`indexedFields` is a policy, not a list of convenience. Name the keys when you
know them:

```json
{ "policy": "declared", "keys": ["sku", "price", "stock_status"] }
```

An empty `keys` array means none, and it means that because the policy says so.
When the synced system owns the vocabulary — a WooCommerce catalogue, a CRM's
custom fields — say so and bound how many keys one document may carry:

```json
{ "policy": "dynamic", "maxFields": 32 }
```

`maxFields` runs from 1 to 64.

Backfill runs under the `scheduled_task` execution class.

### external_webhook_handler

A signed push from outside.

| Field | Meaning |
|---|---|
| `documentSources` | Ids of the `document_source` contributions this handler writes through |
| `authentication.kind` | `hmac_sha256` |
| `authentication.secretConnectionSlot` | A `generated_secret` or `secret_fields` slot holding the signing key |
| `authentication.signatureHeader` | Header carrying the signature, such as `X-Radioso-Signature` |
| `authentication.signaturePrefix` | Optional prefix inside that header, such as `sha256=` |
| `maxBodyBytes` | Largest body the host accepts, up to 4 MiB — the ceiling the invocation input carries |
| `replayWindowSeconds` | How long a delivery id stays unrepeatable, up to 3 600 |

The host verifies the HMAC over the raw body before your App sees anything.
Invocations run under the `external_webhook` execution class.

### scheduled_task

Work on a clock.

| Field | Meaning |
|---|---|
| `documentSources` | Ids of the `document_source` contributions this task writes through |
| `schedule` | `{ "kind": "interval", "seconds": 900 }`, or `{ "kind": "interval_from_configuration", "field": "poll_interval_sec", "minSeconds": 60 }` |
| `overlapPolicy` | `skip`, `queue`, or `replace` when the previous run is still going |
| `maxDurationSeconds` | Longest a single run may take, up to 3 600 |
| `retry` | `maxAttempts` 1 to 10, with `backoff` `{ "kind": "exponential", "baseSeconds": 30, "maxSeconds": 900 }` |
| `checkpointCollection` | Optional collection the host round-trips your checkpoint through |

An `interval_from_configuration` field must be a `number` configuration field,
and `minSeconds` is the floor the host enforces on any interval it runs.

An `interval_from_configuration` schedule also takes an optional
`disabledValue`. A configuration value equal to it leaves the task inactive, so
`{ "field": "poll_interval_sec", "minSeconds": 60, "disabledValue": 0 }` gives a
push-only installation no schedule at all rather than a one-minute one.
`disabledValue` sits outside the interval range on purpose and is not measured
against `minSeconds`.

Invocations run under the `scheduled_task` execution class.

A handler that writes documents names its sources. `documentSources` is how the
host knows whose external-id namespace, indexed-field vocabulary, and provenance
an effect belongs to before it lands — and it is what a `documents.ingest` or
`documents.delete` call references as its `sourceContributionId`.

### Kinds a Release A host declines

`tool`, `context_provider`, `event_subscription`, `ui`, and `pack` parse down to
the common header and leave the rest of their keys unread — the one place a
manifest is not strict, so a manifest written against a later release still gets
one clear answer here instead of a wall of unknown-key noise. Validation returns `unsupported_contribution_kind` for each
one, with the path of the offending `kind`. Any other value fails parsing
outright.

## resourceProfile

`memoryMb` (64–4096), `cpuMillis` (100–4000), `maxConcurrentInvocations` (1–64),
and `scratchMb` (0–4096). The host sizes the process from these and holds you to
them.

## setupGuide and companionAssets

What the operator reads and downloads while wiring the installation up. The host
renders both; your App draws no screens.

```json
{
  "setupGuide": {
    "sections": [
      {
        "title": "Install the Radioso Sync plugin",
        "paragraphs": ["The companion plugin pushes content the moment it changes."],
        "steps": ["Download radioso-sync.zip from this page.", "Upload it in Plugins, then Add New."]
      }
    ]
  },
  "companionAssets": [
    {
      "id": "companion_plugin",
      "label": "Radioso Sync plugin for WordPress",
      "fileName": "radioso-sync.zip",
      "mediaType": "application/zip",
      "digest": "sha256:1f0c…"
    }
  ]
}
```

A section holds 1 to 10 paragraphs of up to 1 000 characters and up to 20 steps
of up to 600. A manifest carries up to 10 sections and up to 8 companion assets.

## conformanceFixtures

Recorded cases the conformance harness replays against your contributions. Each
one is `{ "id", "contributionId", "description", "path" }`, where `path` is
relative to the App package. The harness selects fixtures by the contributions a
manifest declares.

## Validating a manifest

```ts
import { releaseAValidationPolicy, validateManifest } from "@radioso/app-contract";

const result = validateManifest(manifest, releaseAValidationPolicy);
if (!result.ok) {
  for (const issue of result.issues) {
    console.error(`${issue.path}: ${issue.code} — ${issue.message}`);
  }
}
```

`validateManifest` runs three passes and reports all of them, so one round trip
gives you the whole list. First the schema, then every reference the manifest
makes to its own declarations, then what this host admits. A `path` is a dot and
bracket path such as `contributions[1].authentication.secretConnectionSlot`.

| Code | Raised when |
|---|---|
| `schema` | A field fails the schema. `message` is the schema's own text. |
| `duplicate_id` | Two entries in one family share an id or key. |
| `unknown_index_field` | An index names a field the record schema does not declare. |
| `non_scalar_index_field` | An index sits on a `json` field. |
| `unknown_connection_slot` | A `connection_slot` field, a destination, or a webhook handler names a slot that does not exist. |
| `invalid_webhook_secret_slot` | A webhook handler's slot cannot hold a signing secret. |
| `unknown_configuration_field` | A configuration-bound destination host or an `interval_from_configuration` schedule names a field that does not exist. |
| `destination_host_field_not_url` | A destination host is bound to a field that is not a `url` field. |
| `interval_field_not_number` | An interval reads from a field that is not a `number` field. |
| `unknown_destination` | A contribution lists an `egressDestinations` id no destination declares. |
| `unknown_collection` | A `checkpointCollection` or backfill collection does not exist. |
| `unknown_contribution` | A conformance fixture names a contribution the manifest does not declare. |
| `unknown_document_source` | A `documentSources` entry names a contribution the manifest does not declare. |
| `not_a_document_source` | A `documentSources` entry names a contribution that is not a `document_source`. |
| `permission_not_declared` | A contribution asks for a permission the manifest does not declare. |
| `unsupported_permission` | The manifest declares a permission the host does not offer. |
| `unsupported_connection_kind` | The manifest declares a connection kind the host does not offer. |
| `unsupported_contribution_kind` | The manifest declares a contribution kind the host does not offer. |

## Read next

- [Runtime Protocol](./runtime-protocol.md) — what an invocation looks like on
  the wire and which host capabilities you can call.
