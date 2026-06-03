# Radioso Enterprise Edition

This directory contains Radioso Enterprise Edition code. It is commercial
source-available software governed by [LICENSE](./LICENSE), not by the
open-source license that may apply to the rest of this repository.

Enterprise Edition packages live under `ee/packages` so they can keep package
boundaries without requiring a second repository.

## Architecture boundaries

Enterprise backend features register through focused application modules. The
top-level `@radioso/enterprise-backend-module` export aggregates those modules;
feature-specific routes, migrators, hooks, providers, and lifecycle behavior
belong beside the feature implementation.

Feature manifests describe ownership metadata such as feature id, edition,
backend module id, API namespace, frontend route stubs, and docs. The frontend
route sync script reads Enterprise frontend manifests from:

```text
ee/packages/auth-frontend/feature-manifest.mjs
ee/packages/embed-widget/feature-manifest.mjs
```

Run boundary validation from the repository root with:

```bash
node scripts/validate-architecture-boundaries.mjs
```

The validation protects the OSS code path from direct Enterprise imports and
keeps public backend contract surfaces explicit. Generated frontend route files
remain temporary local artifacts and are not the source of truth.

## Local development

From the repository root:

```bash
./run-ee-dev.sh
```

This generates the Enterprise Edition frontend route files locally before
starting Next.js. The generated route files are ignored by git and are removed
again by the normal `./run-dev.sh` bootstrap path.

From this directory:

```bash
pnpm run build
pnpm test
```

## Auth email cutover

Password reset and email verification now live in the OSS auth module. Enterprise no longer owns `/api/v1/ee/auth/*` reset or verification routes, frontend reset or verification pages, mail token migrators, or `ee_*` auth email token tables.

This is an intentional hard cutover. Active links issued by the old Enterprise implementation are not migrated into `password_reset_tokens` or `email_verification_tokens`. After upgrading, users with old reset or verification emails should request fresh links.

## Usage limit profiles

The Enterprise backend module adds hosted usage limit profiles. Accounts without
an assigned profile remain unlimited. The module seeds two starter profiles,
`starter_100` and `starter_250`, with 100 and 250 customer-facing answer calls
per UTC month and an equal number of stored documents across all workspaces in
the account. New accounts are assigned `starter_100` by default.

Set `EE_USAGE_ADMIN_TOKEN` to enable the operator API:

```bash
EE_USAGE_ADMIN_TOKEN=change-me
```

Operator requests use `Authorization: Bearer <token>` against:

```text
/api/v1/ee/usage-limits
```

The API can list or upsert profiles, assign or clear an account profile, and
inspect an account's current usage for a UTC month.

Signed-in Enterprise users can view their assigned profile and current account
usage from the dashboard user menu under Usage. The dashboard reads the
session-scoped endpoint:

```text
GET /api/v1/ee/usage-limits/me
```

## Contact requests

Enterprise builds use the shared backend contact request routine. Operators
enable contact requests per assistant from the Skills tab.

When enabled, the public chat "contact a human" action starts the contact
routine. The assistant collects the visitor's email address and message, then
sends the request to the workspace owner or an admin through the shared mail
pipeline.
