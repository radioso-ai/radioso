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
ee/packages/agent-wizard-frontend/feature-manifest.mjs
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

## Talk to a human

The Enterprise backend module adds workspace-level "Talk to a human" requests
through the chat skill intake runtime.

Operators configure it with:

- an enabled flag
- optional email delivery with a default recipient
- optional webhook delivery with a webhook URL
- an auto-generated signing token for webhook signatures

When enabled and fully configured, a user can ask for human follow-up in chat.
The contact skill intake collects the required email address, builds the request
from the conversation context, stores it, and dispatches delivery in the
background.

Routes are mounted by the Enterprise backend module:

```text
GET  /api/v1/ee/contact/settings
GET  /api/v1/ee/contact/settings/signing-secret
PUT  /api/v1/ee/contact/settings
```

The legacy direct submission endpoints are retired:

```text
POST /api/v1/ee/contact/draft
POST /api/v1/ee/contact/submit
POST /api/v1/ee/contact/public/chat/{token}/draft
POST /api/v1/ee/contact/public/chat/{token}/submit
```

Integrations should send normal chat messages that express the human-contact
intent. The assistant skill intake then collects required fields and submits the
request through the same durable delivery pipeline.

The module stores configuration in `ee_contact_settings`. Durable contact
requests are stored as `human_contact.request` rows in `skill_submissions`.

Webhook requests are `POST` JSON payloads with:

```json
{
  "requestId": "uuid",
  "accountId": "uuid-or-null",
  "workspaceId": "uuid",
  "conversationId": "uuid",
  "assistantMessageId": "uuid-or-null",
  "sourceChannel": "authenticated_chat",
  "sourceOrigin": null,
  "email": "visitor@example.com",
  "message": "Conversation summary or user-provided follow-up request",
  "triggerSource": "explicit_user_request",
  "triggerReason": "The user completed a human-contact chat intake.",
  "createdAt": "2026-05-04T12:00:00.000Z"
}
```

Each payload includes:

```text
x-radioso-event: human_contact.requested
x-radioso-signature: sha256=<hex hmac>
```

The HMAC is computed over the raw JSON body with the workspace signing token.
Failed email or webhook delivery retries with exponential backoff for up to 8
attempts, then the request is marked failed with the final delivery error.
