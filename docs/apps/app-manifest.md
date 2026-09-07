---
title: "App Manifest Reference"
description: "Every section of a Radioso App manifest: identity, artifact, permissions, configuration, connections, destinations, storage collections, contributions, setup guide, and the issue codes validation returns."
last_updated: 2026-09-07
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

Every field carries `key`, `label`, and optionally `description` and
`placeholder`. Every field but `connection_slot` also carries `required`. `type`
decides the rest, and each type accepts only what that type can mean:

| `type` | Carries |
|---|---|
| `text` | Optional `default`, a string |
| `url` | Optional `default`, a string that parses as a URL |
| `number` | Optional `default`, `min`, and `max`, all numbers; `max` is at least `min`, and `default` sits between them |
| `boolean` | Optional `default`, a boolean |
| `select` | `options` with a `value` and a `label` each, values distinct, and an optional `default` that is one of those values |
| `connection_slot` | `connectionSlot`, the id of a slot declared under `connections`, and no `default` or `required` |

A `number` field cannot default to a word, and a `connection_slot` field carries
no default at all. Credential material belongs in the slot, which is why there
is no secret field type here: configuration values are visible to the operator,
appear in the installation plan, and are readable by your App.

A `connection_slot` field carries no `required` either. Whether an installation
has to bind that slot comes from the contributions it turns on, through their
`requiredConnectionSlots`, so a push-only installation is never asked for the
credential only a poll needs.

A default is held to the same rules the value is: a `url` default that is not a
URL, a `number` default outside its own bounds, and two `select` options that
resolve to the same value all fail parsing.

### Effective configuration

The host stores what the operator typed, which is sparse: a field the operator
left alone has no stored value, and the manifest owns its default. What your App
reads is the effective configuration — the stored values with every declared
default materialized. A field that is optional and declares no default is absent
from the result, which is the one gap a handler codes around.
`resolveConfiguration` is the one operation that produces it:

```ts
import { resolveConfiguration } from "@radioso/app-contract";

const resolved = resolveConfiguration(manifest, storedValues);
if (resolved.ok) {
  // resolved.configuration is what an invocation carries as context.configuration
}
```

It bounds the stored map, copies it, materializes the defaults, and validates the
map that results. It reports a missing required value with no default, an
undeclared key, a value of the wrong type, a number outside `min`/`max`, a number
outside the interval range of a schedule that reads it, a `select` value that is
not an option, a `url` value that does not parse or that carries a query or a
fragment, a string over 4 096 characters, and a value supplied for a
`connection_slot` field, which holds none. A stored map carries at most 64
entries, each key spelled the way a field key is spelled; the reported list stops
at 32 issues.

An issue names a key only when the manifest declares that key. Everything else is
addressed by its position in the stored map — `configuration.3` — so a key an
attacker chose reaches no log, no audit record, and no operator's screen, however
much it looks like a field key. Values are never repeated back either.

`resolveConfiguration` returns an `EffectiveConfiguration`, a branded type
nothing else produces. `installationReadiness` takes that type and only that
type, so a stored map with a required field missing cannot be read as an
authoritative answer about what an installation runs.

The host delivers the result to your App on every invocation, as
`context.configuration` — see
[Runtime Protocol](./runtime-protocol.md#installation-context).

### A URL field a destination is built from

When a `url` field backs a destination host, its value is held to that
destination as well as to its own type. The scheme has to be one the destination
declares under `protocols`, and the URL carries no user name or password:
credentials belong in a connection slot, not in a value space the App reads.

The URL is an origin prefix. The broker keeps its scheme, host, port, and path,
and appends an `egress.fetch` request's origin-relative `path` below it, so a
site installed at `https://example.com/wordpress` is reached at
`https://example.com/wordpress/wp-json/wp/v2/posts` and no request an App makes
climbs above the prefix the operator entered. Being a prefix is also why the
value carries no query and no fragment: `https://example.com/wordpress?preview=1`
is refused, because each request supplies its own `path` and `query`.

When two destinations are built from one field, they have to share at least one
protocol. Two views of the same operator-typed address that agree on no scheme
describe an installation no URL can satisfy.

### Which contributions an installation runs

Readiness follows from the manifest and the effective configuration, never from a
list a caller assembles:

```ts
import { installationReadiness } from "@radioso/app-contract";

const { activeContributionIds, inactiveContributionIds, requiredConnectionSlots } =
  installationReadiness(manifest, resolved.configuration);
```

A contribution with `availability: "required"` is always active. A
`scheduled_task` reading `interval_from_configuration` is inactive when its
configuration field holds the schedule's own `disabledValue`. Everything else is
active. Only a resolved configuration reaches this function, so the value it
reads is already known to be either the sentinel or a runnable interval. `requiredConnectionSlots` is the sorted union of the slots the active
contributions require, so a push-only installation is never asked for the
credential only a poll needs.

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

A field's `required` means mandatory once the slot is bound, not that every
installation has to bind the slot. Which slots an installation must bind follows
from the contributions it turns on — see `requiredConnectionSlots` below.

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
  "dataClasses": ["credentials", "operational_metadata"],
  "credentials": {
    "slot": "site_credentials",
    "application": {
      "mode": "http_basic",
      "usernameField": "wp_username",
      "passwordField": "wp_application_password"
    },
    "required": false
  }
}
```

A configuration-bound host must name a `url` field. That is what lets one
release serve many sites without one installation reaching another's. The value
the operator enters is an origin prefix, and its scheme has to be one of this
destination's `protocols`.

A destination id is your App's only handle to a connection. An invocation carries
no credential and no connection reference of any other kind: you name a
destination on an `egress.fetch` call, and the broker resolves the address and
attaches the credential.

`protocols` holds `https`, `http`, or both. `http` is here because a self-hosted
site reachable only over plain HTTP is a real installation; declaring it puts it
on the operator's grant screen, one destination at a time.

`ports` is optional. `purpose` is the sentence the operator reads on the grant
screen. `dataClasses` says what leaves the platform on this destination — `document_content`, `document_metadata`,
`installation_configuration`, `credentials`, or `operational_metadata`.

`credentials` says which slot the broker draws from and what it builds out of
it. Your App never holds the secret, so the manifest has to state the mechanism:

| `application.mode` | Builds |
|---|---|
| `http_basic` | An `Authorization: Basic` header from `usernameField` and `passwordField` |
| `bearer` | An `Authorization: Bearer` header from `tokenField` |
| `header` | The named `header`, carrying `valueField` |

Every named field must exist in the slot, and the slot must be `secret_fields` —
a `generated_secret` holds one opaque value and no fields to build a request
from. Each named field is `required: true`, because a credential the broker
builds on every request is not one an operator may leave empty, and the field
carrying the secret half — the password, the token, the header value — is
`sensitive: true`. A destination that attaches a credential lists `credentials`
in its `dataClasses`, so the grant screen says so.

`header` cannot name a header the broker owns: `host`, `content-length`,
`transfer-encoding`, `connection`, `upgrade`, `te`, `trailer`, `keep-alive`,
`proxy-authorization`, `proxy-connection`, or `proxy-authenticate`, matched
without regard to case.

`required` says whether the destination is reachable without the credential.
`false` has the broker send the request anonymously while the slot is unbound
and inject the credential once it is bound, which is what lets one release serve
an installation that reads public content and one that reads private content.
`true` means the destination is never reachable unbound, so every contribution
that names the destination lists that slot in its `requiredConnectionSlots`.

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

`quotas.maxRecords` runs to 1 000 000 and `quotas.maxRecordBytes` to 65 536, the
serialized ceiling every protocol message shares. A collection declaring more
would promise capacity the wire refuses.

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
| `requiredConnectionSlots` | Ids of the slots this contribution cannot run without, each named once |

`requiredConnectionSlots` is what makes a connection conditional. A slot is
required for an installation only when a contribution that names it is active,
so a site that only receives pushes needs the signing secret and nothing else,
while turning polling on asks the operator for the site credentials. Field-level
`required` inside a slot still means mandatory once the slot is bound.

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
| `authentication.secretField` | Which field of a `secret_fields` slot carries the key |
| `authentication.signatureHeader` | Header carrying the signature, such as `X-Radioso-Signature` |
| `authentication.signaturePrefix` | Optional prefix inside that header, such as `sha256=` |
| `maxBodyBytes` | Largest body the host accepts, up to 4 MiB — the ceiling the invocation input carries |
| `replayWindowSeconds` | How long a delivery id stays unrepeatable, up to 3 600 |

A `generated_secret` slot holds one value, so naming the slot names the key and
`secretField` is left out. A `secret_fields` slot holds several, so the handler
says which one signs: that field is `required: true` and `sensitive: true`, the
same rules a destination credential's secret half is held to, because the gateway
computes an HMAC with it on every delivery.

The host verifies the HMAC over the raw body before your App sees anything, so
the handler lists `authentication.secretConnectionSlot` in its
`requiredConnectionSlots`: a handler that cannot verify a delivery is a handler
that cannot run. Invocations run under the `external_webhook` execution class.

### scheduled_task

Work on a clock.

| Field | Meaning |
|---|---|
| `documentSources` | Ids of the `document_source` contributions this task writes through |
| `schedule` | `{ "kind": "interval", "seconds": 900 }`, or `{ "kind": "interval_from_configuration", "field": "poll_interval_sec", "minSeconds": 60, "maxSeconds": 86400 }` |
| `overlapPolicy` | `skip`, `queue`, or `replace` when the previous run is still going |
| `maxDurationSeconds` | Longest a single run may take, up to 3 600 |
| `retry` | `maxAttempts` 1 to 10, with `backoff` `{ "kind": "exponential", "baseSeconds": 30, "maxSeconds": 900 }` |
| `checkpointCollection` | Optional collection the host round-trips your checkpoint through |

An `interval_from_configuration` field must be a `number` configuration field,
and `minSeconds` and `maxSeconds` close the range of intervals the host runs:
60 seconds to 30 days, `maxSeconds` at least `minSeconds`. Both are required,
because a floor with nothing above it leaves "any number at all" as the value
space, and a host meeting 0.5 or 31 536 000 would have to invent a clamp.

An `interval_from_configuration` schedule also takes an optional
`disabledValue`. A configuration value equal to it leaves the task inactive, so
`{ "field": "poll_interval_sec", "minSeconds": 60, "maxSeconds": 86400,
"disabledValue": 0 }` gives a push-only installation no schedule at all rather
than a one-minute one. `disabledValue` must sit below `minSeconds`. A sentinel
inside the interval range would silently disable a schedule the operator meant to
run.

That makes the field's value space exactly two things: the sentinel, or a whole
number of seconds from `minSeconds` to `maxSeconds`. `resolveConfiguration`
holds a stored value to it and reports `schedule_value_out_of_range` for anything
else, so a 30 against a 60 second floor is refused where an operator can still
fix it.

A task with `availability: "required"` declares no `disabledValue`. It is active
in every installation, so a value that claims to turn it off could only
contradict that.

The referenced field's own range has to admit both. `disabledValue` sits inside
the field's `min` and `max` when either is declared, or the schedule is one
nobody can turn off; and the field's range has to overlap `minSeconds` to
`maxSeconds`, or the schedule is one that can never run.

Invocations run under the `scheduled_task` execution class.

A handler that writes documents names its sources. `documentSources` is how the
host knows whose external-id namespace, indexed-field vocabulary, and provenance
an effect belongs to before it lands — and it is what a `documents.ingest` or
`documents.delete` call references as its `sourceContributionId`.

A contribution that asks for `documents.ingest` or `documents.delete` names at
least one source, and names each one once. A handler admitted with an empty list
would hold a permission it could never exercise.

### Kinds a Release A host declines

`tool`, `context_provider`, `event_subscription`, `ui`, and `pack` parse down to
the common header and leave the rest of their keys unread — the one place a
manifest is not strict, so a manifest that declares one gets a single clear
answer instead of a wall of unknown-key noise. Validation returns
`unsupported_contribution_kind` for each one, with the path of the offending
`kind`. Any other value fails parsing outright.

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
| `unknown_connection_slot` | A `connection_slot` field, a destination credential, a `requiredConnectionSlots` entry, or a webhook handler names a slot that does not exist. |
| `invalid_destination_credential_slot` | A destination credential names a slot that holds no fields a request can be built from. |
| `unknown_connection_field` | A credential application or a webhook's `secretField` names a field its slot does not hold. |
| `credential_field_not_required` | A credential application or a webhook signing field names a field the operator may leave empty. |
| `credential_field_not_sensitive` | The secret half of a credential — the password, token, header value, or webhook signing key — is stored in a field that is not `sensitive`. |
| `missing_credentials_data_class` | A destination attaches a credential without listing `credentials` in `dataClasses`. |
| `destination_credentials_not_required` | A contribution reaches a destination whose credential is mandatory without requiring that slot. |
| `webhook_secret_not_required` | A webhook handler verifies against a slot it does not list in `requiredConnectionSlots`. |
| `invalid_webhook_secret_slot` | A webhook handler's slot cannot hold a signing secret. |
| `webhook_secret_field_required` | A webhook handler's slot is `secret_fields` and the handler names no `secretField`. |
| `webhook_secret_field_not_allowed` | A webhook handler names a `secretField` beside a slot that holds one value. |
| `unknown_configuration_field` | A configuration-bound destination host or an `interval_from_configuration` schedule names a field that does not exist. |
| `destination_host_field_not_url` | A destination host is bound to a field that is not a `url` field. |
| `interval_field_not_number` | An interval reads from a field that is not a `number` field. |
| `disabled_value_outside_field_range` | A schedule's `disabledValue` sits outside the range its configuration field admits, so the task can never be turned off. |
| `schedule_range_unreachable` | A schedule's configuration field admits no value between `minSeconds` and `maxSeconds`, so the task can never run. |
| `required_schedule_cannot_disable` | A `required` scheduled task declares a `disabledValue`. |
| `destination_protocols_incompatible` | Two destinations built from one configuration field share no protocol. |
| `unknown_destination` | A contribution lists an `egressDestinations` id no destination declares. |
| `unknown_collection` | A `checkpointCollection` or backfill collection does not exist. |
| `unknown_contribution` | A conformance fixture names a contribution the manifest does not declare. |
| `unknown_document_source` | A `documentSources` entry names a contribution the manifest does not declare. |
| `not_a_document_source` | A `documentSources` entry names a contribution that is not a `document_source`. |
| `missing_document_source` | A contribution asks for a document permission and names no source to write through. |
| `permission_not_declared` | A contribution asks for a permission the manifest does not declare. |
| `unsupported_permission` | The manifest declares a permission the host does not offer. |
| `unsupported_connection_kind` | The manifest declares a connection kind the host does not offer. |
| `unsupported_contribution_kind` | The manifest declares a contribution kind the host does not offer. |

## Read next

- [Runtime Protocol](./runtime-protocol.md) — what an invocation looks like on
  the wire and which host capabilities you can call.
