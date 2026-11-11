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

Enterprise operator surfaces reach the operator copilot through
`registerCopilotTools`. A contribution carries its descriptors together with the
operation and application-primitive identities they cite, because the OSS public
contract and owning-port registry describe OSS surfaces only. The copilot
contract is mirrored structurally in
`ee/packages/backend-module/src/copilotContributionTypes.ts` and re-exported from
`radiosoModuleTypes.ts`, the same arrangement the other registration ports use,
so Enterprise code contributes tools without importing OSS types. `usageLimits/copilotTools.ts` is the worked example.

A feature that wants Ray to propose a change for an operator to review registers
it with `registerCopilotProposalAdapter`. The contribution names a target type the
feature owns, such as `alert_threshold`, the workspace permissions to read and to
apply its proposals, an adapter, and the name, description, input schema, and
capability declaration of the propose tool Ray offers for it. Ray builds that tool:
the adapter's `draft` turns the tool's input into a change, a target label, a
summary, and a `presentation` (the link label and a dashboard path inside the
workspace, such as `/settings?settingsTab=usage`), and Ray stores, audits, and
shows the proposal like a first-party one. Applying it calls the adapter's
`applyIfVersionMatches` once per apply claim, after Ray checks the operator still
holds the manage permissions. `canRetryAfterInterruptedApply` is required: return
false for a create, so an apply interrupted before its outcome was recorded is
resolved as interrupted rather than creating the target twice. OSS refuses to boot
when a contributed target type is first-party or another module already
contributed it. The proposal shows in the dashboard's Ray panel; contributed propose
tools stay off Operator MCP.

Feature manifests describe ownership metadata such as feature id, edition,
backend module id, API namespace, frontend route stubs, and docs. The frontend
route sync script reads Enterprise frontend manifests from:

```text
ee/packages/auth-frontend/feature-manifest.mjs
ee/packages/operator-console/feature-manifest.mjs
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
the account.

The module seeds one profile per plan in `@radioso/plan-catalog`
(`comet`, `satellite`, `planet`) with that plan's conversation, document, and
storage limits. Console edits to a seeded profile always win: the seed only
ever inserts, never overwrites. New accounts are assigned the catalog's
`defaultPlanId` (`comet`) by default. `GET /api/v1/plans` serves the same
catalog publicly, unauthenticated, for the website pricing page and signup
flows.

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

Enterprise keeps open signup available and lets signed-in users create
additional organizations. The additional-organization path is capped per user
as an anti-abuse velocity control. This is separate from account usage limit
profiles. Signup does not consume the counter, even when other organizations
already exist. Deleting organizations does not refund the monthly counter.

Open-source deployments differ: the first signup creates the server's sole
organization, then later users join it by invitation. Workspace creation remains
available in both editions and does not consume the organization counter.

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

The organizations list shows each account's tier and the meter that tier bills
on, for the current UTC month. A catalog-plan account reads the conversation
meter (`12.5 / 50 conv`); an answer-metered profile such as `starter_100` reads
the answer counter (`8 / 100`). An account with no assigned profile reads
unlimited.

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
(role `owner`), not from `accounts.email`. Each directory row carries
`conversationSpend` for the current month, and the organization usage read
carries `conversationSpend.current` and `conversationSpend.previous`; both are
described under [Conversation spend](#conversation-spend). Tier changes and
staff changes are recorded as `staff.*` audit events. The console pages are served under
`/operator` when Enterprise frontend routes are enabled.

### Conversation spend

Each organization row also shows what the account's customer conversations
cost in model spend this month, on average: `€0.021 / conv`. The organization
page shows this month and last month side by side, since a month only two days
old averages over a handful of conversations. An average above €0.04 gets the
console's amber warning in both places. €0.04 is where Planet, at full quota,
drops below a 50% gross margin, so a flagged account is one whose conversations
run long enough to eat into the plan.

The average divides spend by metered conversations, and both sides come from
data the platform already records:

- Metered conversations are the customer conversations the conversation meter
  recorded replies for: customer-channel replies only, so Test Chat, Ray, Pulse
  reports, and one-shot retrieval answers sit outside it. Each conversation
  counts once per block of the tier's replies per conversation, so on the
  catalog plans' 10 an 8-reply conversation is one and a 12-reply conversation
  is two.
- The block size is the tier's replies per conversation as set now, for both
  months shown. The meter charges each reply under the setting in force at the
  time, and that setting is not recorded per reply, so changing it re-counts
  both months. The organization page states the value it counted at.
- Spend is every call the usage ledger (`usage_events`) attributes to those
  conversations in the same UTC month that the provider billed: planning,
  answers, rerank, extraction, embeddings, and summaries. That includes a reply
  stream the visitor interrupted or replaced, which records the tokens the
  provider reported. A failed call with no provider-reported usage is left out:
  its token count is an estimate from the request size, and a request the
  provider rejected was never billed. An interrupted call that never got a usage
  report is therefore missing too.
- Tokens are priced at list price, with cached input charged at the full input
  rate. Prices are in USD and converted at a fixed `eurPerUsd` (0.90). The
  prices, the rate, and the €0.04 threshold are `MODEL_SPEND_ESTIMATE` in
  `@radioso/plan-catalog` (`src/modelSpend.json`), a staff-only export kept
  apart from the public `PLAN_CATALOG` that `GET /api/v1/plans` serves.
- A call on a model the catalog has no price for is counted rather than priced,
  and the average becomes a floor: `≥ €0.021 / conv`. A floor under €0.04 could
  still be over it, so the directory reads it as `(undetermined)` and the
  organization page says how many calls it left out. A floor already over €0.04
  is flagged.
- Every call is priced, including calls an account makes on its own provider
  key. For a bring-your-own-key account the figure is what its conversations
  would cost on the platform's keys.

The computation reads token counts and model names from the ledger; prompt and
completion text is never part of it.

The flag is a prompt to look, not an automatic action. If a flagged account's
conversations stay long month after month, there are two levers. Lower that
plan's replies per conversation from 10 to 6 on the Tiers page, which makes a
long conversation count as more than one. Or give the account a tier of its own
with its own replies per conversation, so one customer's conversation
definition changes without touching everyone else on the plan. Either lever
re-counts both months shown at the new value, last month included, even though
last month was charged under the old one. So read the month after the change to
see what the lever does, and keep in mind that lowering a plan's value lowers
every account's figure on that plan at once. Metering by spend instead of by
conversation stays out unless the measured mix changes: it makes bills
unpredictable for customers, ties them to internal prompt and model changes, and
charges token-heavy languages more for the same conversation.

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

The redirect URI is derived from `APP_BASE_URL`. On a self-hosted deployment
whose public host differs — behind a reverse proxy, say — set
`GOOGLE_LOGIN_REDIRECT_URI` to the URL Google should call back. After a
successful sign-in the browser returns to `APP_BASE_URL`, and
`GOOGLE_LOGIN_SUCCESS_REDIRECT` sends it somewhere else. Both are backend
environment variables you set yourself. The bundled Cloud Run stack described
below carries the client id and secret, so there the callback URL is always
`<APP_BASE_URL>/api/v1/ee/auth/google/callback`.

The callback has to land on the dashboard origin. Both the CSRF state cookie and
the session cookie are host-only, so a callback that arrives anywhere else can
neither read the state it must match nor set a session the app sees; the
frontend forwards `/api/v1/ee/auth/google/*` to the backend through its
`/backend` proxy to keep the whole round trip on one origin. A redirect URI
pointed at the API host fails every sign-in with an invalid-state error.

On the bundled Cloud Run stack, set `GOOGLE_LOGIN_CLIENT_ID` and
`GOOGLE_LOGIN_CLIENT_SECRET` as GitHub environment secrets; the Terraform
workflow stores them in Secret Manager and injects them into the backend
service. Each region has its own `APP_BASE_URL`, so add every region's callback
URL to the OAuth client.

Deploy the frontend release that carries the callback route before you apply the
credentials. The deploy workflow resolves the frontend image from the service
already running and hands it to Terraform, which never advances it, so
credentials applied first turn the button on while the browser still lands on a
404 coming back from Google.

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
