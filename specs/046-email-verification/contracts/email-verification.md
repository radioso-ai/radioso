# Contracts: Email Verification Gate

## POST /api/v1/auth/register

Request:
- `email: string`
- `password: string`
- `organizationName?: string`

Response `201`:
- `userId: string`
- `accountId: string`
- `organizationName: string`
- `workspaceId: string`
- `workspaceName: string`
- `requiresEmailVerification: true`

No session cookie is set.

## POST /api/v1/auth/login

Existing request contract.

New failure response `403`:
- error code: `email_verification_required`
- message explains verification is required before sign-in

## POST /api/v1/auth/email-verification/verify

Request:
- `token: string`

Response `200`:
- `verified: true`

Failure:
- `401` for invalid/expired/used tokens with actionable message

## POST /api/v1/auth/email-verification/resend

Request:
- `email: string`

Response `202`:
- `accepted: true`

Notes:
- response shape does not enumerate usable identities
- verified users keep verified state and do not regress
