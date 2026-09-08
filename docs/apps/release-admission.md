---
title: "Release Admission"
description: "What a Radioso App release is, the states it moves through, and what admission establishes — and records that it did not establish — before a release becomes installable."
last_updated: 2026-09-08
---

# Release Admission

A release is the unit a workspace installs. It bundles one manifest, one
executable artifact pinned by digest, and the admission decision that made it
installable — and once that version exists, none of it changes. A new build, a
widened permission, a changed destination, a new storage collection: each
becomes a new version and a new release, checked from scratch.

## Where a release comes from

Radioso ships a built-in registry, and that registry is the trust root. A
release exists because Radioso built it, listed its artifact digests, and
shipped it; admission runs over that list when the platform starts. The
WordPress reference App is published through the same registry, written and
admitted exactly the way any App is, so what the registry enforces is the real
protocol rather than a shortcut taken because the publisher happens to be
Radioso.

The registry identity is recorded separately as `trustRoot`, so the evidence
does not imply that a publisher signature or provenance check ran.

## What admission establishes

Admission validates the manifest, pins registry digests, checks compatibility,
and records those results:

- **The manifest validates under the Release A policy.** Admission runs
  `validateManifest` from `@radioso/app-contract` and requires `ok: true` —
  see [how validation issues surface](#how-validation-issues-surface-in-a-decision)
  below.
- **Every digest resolves against the registry.** The executable artifact and,
  when the manifest declares one, the UI asset digest must match content the
  built-in registry vouches for. A mutable tag or an unpinned reference fails
  outright.
- **Every contribution kind is one Release A runs.** `document_source`,
  `external_webhook_handler`, and `scheduled_task` pass. A manifest can carry
  the reserved kinds' headers, but a release that depends on one to function is
  rejected.
- **Resource bounds hold.** `resourceProfile`, storage quotas, schedule
  intervals, and body and response size limits sit inside the ranges the policy
  defines. A release asking outside them is rejected rather than silently
  clamped.
- **The release supports the Radioso version this host runs.** The manifest's
  `radiosoCompatibility` range is matched against the host's own version, read
  from `RADIOSO_RELEASE` and falling back to the backend package version. A host
  that cannot determine its own version admits nothing: compatibility that
  cannot be established is not compatibility.
- **The version's content has not changed.** If the same app id and version
  already exist, the manifest digest must match the one recorded for that row,
  whatever state the row is in. Publish a new version to change content.

## What the decision records

Each admitted release stores an evidence record beside it, and that record
names both the checks that ran and the checks that did not:

```json
{
  "signature": "not_evaluated",
  "provenance": "not_evaluated",
  "softwareInventory": "not_evaluated",
  "vulnerabilityPolicy": "not_evaluated",
  "conformance": "not_evaluated",
  "compatibility": { "runningVersion": "0.1.0", "range": ">=0.1.0", "result": "compatible" },
  "contributionCount": 3,
  "permissionCount": 5,
  "destinationCount": 1,
  "storageCollectionCount": 1,
  "connectionSlotCount": 2,
  "verifiedDigestCount": 2,
  "trustRoot": "built_in_registry"
}
```

`signature`, `provenance`, `softwareInventory`, `vulnerabilityPolicy`, and
`conformance` all read `not_evaluated`. `trustRoot` identifies the built-in
registry that supplied the digest catalogue. Keeping these distinct makes the
record clear about both what admission established and what it did not.

The counts are counts. An admission decision never becomes a second copy of the
manifest.

## Release states

```text
admitted ──▶ deprecated
    │
    ├──────▶ revoked
    └──────▶ quarantined
```

An admitted release is what workspaces install. `deprecated` still serves
existing installations but drops out of new installation offers; `revoked` and
`quarantined` both stop new execution everywhere the release runs, without
touching a workspace's own configuration or data. Each of those three
transitions is an explicit, audited decision.

Starting the platform is not one of them. Registry synchronisation only inserts
releases that do not exist yet; it never rewrites the state of a row it finds,
so a revoked release stays revoked across a restart.

Because state can change under an approval, installing and activating recheck
it. A plan records the admission policy version and release state it was built
against, and apply, activation, and every resumed step ask again whether the
release is admitted and compatible right now. A release revoked between the
review and the click is refused with `release_not_eligible`, and nothing runs.

## `admissionPolicyVersion`

Every admission decision names the exact policy it was measured against. A
release admitted under `release-a.1` keeps that number even after Radioso ships
a later policy; the recorded version is what an operator or a security review
reads to know which rules actually applied. Tightening the policy does not
retroactively re-admit or reject an already-admitted release — revocation and
quarantine are the tools for acting on one.

The recorded version is also what re-reading a stored release goes through.
Before a stored manifest drives a plan, a configuration decision, or a
connection rule, Radioso recomputes its canonical digest, compares it to the
digest admission recorded, and re-runs the named policy over it. A row edited
by hand or damaged by a migration surfaces as `release_not_admitted` rather
than quietly earning a fresh judgement.

## How validation issues surface in a decision

`validateManifest` returns every issue it finds in one pass — schema failures,
unresolved references, and unsupported kinds or permissions — each with a
stable `code` and a `path` into the manifest. Admission treats any non-empty
issue list as a rejection, and the rejection is recorded with the issue codes
and their count rather than only the first failure. Compatibility and
immutability produce issues in the same shape:
`radioso_version_incompatible`, `radioso_version_undetermined`, and
`release_version_immutable`.

See [Validating a manifest](./app-manifest.md#validating-a-manifest) for the
full table of issue codes.

## Read next

- [App Manifest Reference](./app-manifest.md) — every field a release's
  manifest declares.
- [Runtime Protocol](./runtime-protocol.md) — what an admitted release's
  contributions look like once an installation runs.
