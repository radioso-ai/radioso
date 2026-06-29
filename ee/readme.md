# Radioso Enterprise Edition

This directory contains Radioso Enterprise Edition code. It is commercial
source-available software governed by [LICENSE](./LICENSE), not by the Apache
License, Version 2.0, that applies to the rest of this repository (see the
[LICENSE](../LICENSE) and [NOTICE](../NOTICE) files at the repository root).

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

Enterprise also caps additional organization creation per user as an anti-abuse
velocity control. This is separate from account usage limit profiles. Signup
and the first organization are not capped. Deleting organizations does not
refund the monthly counter.

Set the default monthly cap with:

```bash
EE_MAX_ORGS_PER_USER_PER_MONTH=10
```

The value is per user per UTC calendar month. When unset, the default is 10.
Operators can override a user under the same usage-limit admin API:

```bash
curl -X PUT "$BASE_URL/api/v1/ee/usage-limits/org-creation/users/$USER_ID" \
  -H "Authorization: Bearer $EE_USAGE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"monthlyLimit": 25}'
```

Use `{"monthlyLimit": null}` for an unlimited override. Delete the override to
return the user to the global default:

```text
GET    /api/v1/ee/usage-limits/org-creation/users/:userId
PUT    /api/v1/ee/usage-limits/org-creation/users/:userId
DELETE /api/v1/ee/usage-limits/org-creation/users/:userId
```

## Operator console

The operator console is a staff-facing surface for administering customer
organizations and their usage tiers. It is separate from the customer
dashboard and runs on its own authority axis: a staff identity, not a customer
account. Operators sign in with a staff session and act across all
organizations.

Staff identities are global to the deployment and carry one role:

- `support_read` — read organizations, usage, and tiers.
- `billing_write` — also change an organization's tier and edit the tier catalog.
- `owner` — also manage staff identities and their roles.

The console API is mounted at:

```text
/api/v1/ee/operator-console
```

It uses a staff session cookie, separate from the customer session. Set its
name and lifetime:

```bash
STAFF_SESSION_COOKIE_NAME=radioso_staff_session
STAFF_SESSION_TTL_HOURS=8
```

### First owner and recovery

A fresh install has no staff identity. Use the bootstrap endpoint to create the
first `owner`, or to reset a locked-out owner's password. It is gated only by
`EE_USAGE_ADMIN_TOKEN` and can do nothing else. After the first owner exists,
owners create further staff through the console.

```bash
curl -X POST "$BASE_URL/api/v1/ee/operator-console/bootstrap" \
  -H "Authorization: Bearer $EE_USAGE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "ops@example.com", "name": "Ops", "password": "change-me-please"}'
```

### Console endpoints

All endpoints below use the staff session cookie. Reads allow any role; tier
changes need `billing_write`; staff management needs `owner`.

```text
POST   /api/v1/ee/operator-console/auth/login
POST   /api/v1/ee/operator-console/auth/logout
GET    /api/v1/ee/operator-console/auth/me
GET    /api/v1/ee/operator-console/organizations
GET    /api/v1/ee/operator-console/organizations/:accountId/usage
PUT    /api/v1/ee/operator-console/organizations/:accountId/tier
GET    /api/v1/ee/operator-console/tiers
PUT    /api/v1/ee/operator-console/tiers/:profileKey
GET    /api/v1/ee/operator-console/staff
POST   /api/v1/ee/operator-console/staff
PUT    /api/v1/ee/operator-console/staff/:staffId/role
PUT    /api/v1/ee/operator-console/staff/:staffId/status
```

The organization directory derives the owner email from `account_memberships`
(role `owner`), not from `accounts.email`. Tier changes and staff changes are
recorded as `staff.*` audit events. The console pages are served under
`/operator` when Enterprise frontend routes are enabled.

### Known limits

Two hardening items are intentionally left for a later change. Staff login is
not rate-limited yet; `bcrypt` verification makes brute force slow, but a shared,
backed limiter is the correct fix. Console actions emit audit events and
structured logs, but no metrics counters, because the Enterprise module has no
metrics sink to write to today. Both are tracked as follow-ups.

Signed-in Enterprise users can view their assigned profile and current account
usage from the dashboard user menu under Usage. The dashboard reads the
session-scoped endpoint:

```text
GET /api/v1/ee/usage-limits/me
```

## Google sign-in

The Enterprise backend module adds "Sign in with Google" to the login page,
alongside the standard email and password form. It is disabled until you
configure Google OAuth credentials, so OSS and unconfigured Enterprise builds
show only the password form.

The key point is that Radioso treats Google as a provider of a verified email.
On the first sign-in for a new email, Radioso provisions a fresh account and
default workspace, the same way self-serve registration does. An existing user
is matched by verified email and signed in without creating a second account; an
unverified account is marked verified, because Google has proven control of the
mailbox. There is no email-domain restriction; any Google account can sign in.

Provisioned accounts have no password. Users who later want password sign-in can
set one through the normal "Forgot password" flow.

### Setup

1. In the Google Cloud console, create an OAuth 2.0 Web application client.
2. Add the redirect URI `<APP_BASE_URL>/api/v1/ee/auth/google/callback`. This
   must match the public URL of your deployment.
3. Set the credentials in the backend environment:

```bash
GOOGLE_LOGIN_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_LOGIN_CLIENT_SECRET=your-client-secret
```

The redirect URI is derived from `APP_BASE_URL` by default. Override it with
`GOOGLE_LOGIN_REDIRECT_URI` when the public host differs (for example, behind a
reverse proxy). After a successful sign-in the browser returns to `APP_BASE_URL`;
override the landing page with `GOOGLE_LOGIN_SUCCESS_REDIRECT`.

These variables are distinct from `GOOGLE_MAIL_OAUTH_*`, which configures the
Gmail document connector, not user sign-in.

### How it works

The login page probes `GET /api/v1/ee/auth/google/status` and shows the button
only when the provider reports `{ "enabled": true }`. The sign-in flow uses two
endpoints under the mount path `/api/v1/ee/auth/google`:

```text
GET /api/v1/ee/auth/google/start      # CSRF state cookie, redirect to Google
GET /api/v1/ee/auth/google/callback   # exchange code, issue session, redirect back
```

The callback sets the same session cookie as password login, so the rest of the
app is unchanged.

## Contact requests

Enterprise builds use the shared backend contact request routine. Operators
enable contact requests per assistant from the Skills tab.

When enabled, the public chat "contact a human" action starts the contact
routine. The assistant collects the visitor's email address and message, then
sends the request to the workspace owner or an admin through the shared mail
pipeline.
