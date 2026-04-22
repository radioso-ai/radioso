# Data Model: Email Verification Gate

## Login User

- `id: uuid`
- `email: string`
- `passwordHash: string`
- `emailVerifiedAt: Date | null`
- `createdAt: Date`
- `updatedAt: Date`

State transitions:
- register -> `emailVerifiedAt = null`
- successful verification -> `emailVerifiedAt = now`
- resend -> unchanged

## Email Verification Token

- `id: uuid`
- `userId: uuid`
- `tokenHash: string`
- `expiresAt: Date`
- `usedAt: Date | null`
- `createdAt: Date`
- `requestIp: string | null`
- `requestUserAgent: string | null`

Rules:
- raw token is never stored
- only the latest active token for a user is accepted
- successful verify marks all active tokens used

## API-facing states

- `verification_pending`
  - returned after registration and resend
- `verification_required`
  - returned from blocked login
- `verification_complete`
  - returned after successful verify
