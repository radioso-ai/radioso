# Radioso Enterprise Edition

This directory contains Radioso Enterprise Edition code. It is commercial
source-available software governed by [LICENSE](./LICENSE), not by the
open-source license that may apply to the rest of this repository.

Enterprise Edition packages live under `ee/packages` so they can keep package
boundaries without requiring a second repository.

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
npm run build
npm test
```

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
through Enterprise-only contact routes and a generic core chat action provider.

Operators configure it with:

- an enabled flag
- optional email delivery with a default recipient
- optional webhook delivery with a webhook URL
- an auto-generated signing token for webhook signatures

When enabled and fully configured, chat can show a `contact_human` action in the
generic suggestion action shape. Submit returns `202 Accepted` after the request
is stored. Email and webhook delivery happen in the background.

Routes are mounted by the Enterprise backend module:

```text
GET  /api/v1/ee/contact/settings
GET  /api/v1/ee/contact/settings/signing-secret
PUT  /api/v1/ee/contact/settings
POST /api/v1/ee/contact/draft
POST /api/v1/ee/contact/submit
POST /api/v1/ee/contact/public/chat/{token}/draft
POST /api/v1/ee/contact/public/chat/{token}/submit
```

The module stores configuration in `ee_contact_settings` and durable delivery
requests in `ee_contact_requests`.

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
  "message": "Editable user message",
  "triggerSource": "manual",
  "triggerReason": "optional reason",
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
