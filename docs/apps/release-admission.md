---
title: "Release Admission"
description: "What a Radioso App release is, the states it moves through, and what Release A's admission policy checks before a release becomes installable."
last_updated: 2026-09-06
---

# Release Admission

A release is the unit a workspace installs. It bundles one manifest, one
executable artifact pinned by digest, and the admission decision that made it
installable — and once admitted, none of that changes. A new build, a widened
permission, a changed destination, a new storage collection: each becomes a
new version and a new release, checked from scratch. Nothing patches a release
in place.

## Release states

```text
submitted → validating → admitted
     │           │           │
     │           └──────▶ rejected
     │
     └──────────────────▶ withdrawn

admitted ──▶ deprecated
    │
    ├──────▶ revoked
    └──────▶ quarantined
```

A submitted release moves to `validating` while the admission policy runs
against it, and comes out `admitted` or `rejected`. A publisher can withdraw a
submitted release before that finishes. An admitted release is what workspaces
install; `deprecated` still serves existing installations but drops out of new
installation offers; `revoked` and `quarantined` both stop new execution
everywhere the release runs, without touching a workspace's own configuration
or data. Rollback eligibility is rechecked against current admission policy
every time, not assumed from the release's original decision.

## What Release A's admission policy checks

Admission runs one pass over a submitted release and records every check it
ran, so the decision explains itself later:

- **The release comes from the built-in registry.** Release A's registry is a
  fixed, Radioso-owned list. Admission does not accept a release from
  anywhere else.
- **The signature verifies against a registry-approved key.** A release
  signed with an unrecognized or revoked key never reaches the later checks.
- **Every digest resolves.** The executable artifact and, when the manifest
  declares one, the UI asset digest must match content Radioso's own registry
  holds. A mutable tag or an unpinned reference fails this check outright.
- **The manifest validates under the Release A policy.** Admission runs
  `validateManifest` from `@radioso/app-contract` with the policy this release
  is being measured against, and requires `ok: true` — see
  [how validation issues surface](#how-validation-issues-surface-in-a-decision)
  below.
- **Every contribution kind is one Release A supports.** `document_source`,
  `external_webhook_handler`, and `scheduled_task` pass; a manifest can carry
  the reserved kinds' headers, but admission rejects a release that depends on
  one to function.
- **Resource bounds hold.** `resourceProfile`, storage quotas, schedule
  intervals, and body/response size limits all sit inside the ranges the
  policy defines; a release asking outside them fails admission rather than
  being silently clamped.

The decision this pass produces is recorded with the release, not
recomputed later from memory. Installing, updating to, or rolling back to a
release always rechecks current admission and revocation status at that
moment — an old `admitted` decision does not by itself mean a release stays
installable forever.

## `admissionPolicyVersion`

Every admission decision names the exact policy it was measured against. A
release admitted under policy version 3 keeps that number even after Radioso
ships policy version 4; the recorded version is what an operator or a security
review reads to know which rules actually applied. Tightening the policy
does not retroactively re-admit or reject an already-admitted release —
revocation and quarantine are the explicit tools for acting on one.

## Why Release A does not admit external publishers

Admission in Release A trusts one signing chain: Radioso's own registry keys,
Radioso's own build pipeline, and a policy Radioso operates directly. Trusting
a second publisher's key means distributing and rotating that key safely,
revoking it across every installation that used it, and reviewing what that
publisher submits before it reaches a workspace — none of which the initial
registry builds. The WordPress reference App is published through this same
built-in registry, written and admitted exactly the way a third party's App
would be, so the protocol the registry enforces is real and not a shortcut
taken because the publisher happens to be Radioso.

## How validation issues surface in a decision

`validateManifest` returns every issue it finds in one pass — schema
failures, unresolved references, and unsupported kinds or permissions — each
with a stable `code` and a `path` into the manifest. Admission calls it with
the Release A policy and treats any non-empty issue list as a rejection: the
release moves to `rejected`, and the recorded decision carries the full issue
list rather than only the first failure. A publisher fixing a rejected
release resubmits a new version; the previous submission's issues stay on its
own record as evidence of why it did not pass.

See [Validating a manifest](./app-manifest.md#validating-a-manifest) for the
full table of issue codes.

## Read next

- [App Manifest Reference](./app-manifest.md) — every field a release's
  manifest declares.
- [Runtime Protocol](./runtime-protocol.md) — what an admitted release's
  contributions look like once an installation runs.
