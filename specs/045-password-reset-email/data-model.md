# Data Model: Password Reset Email Recovery

## Login User

Existing entity in `users`.

**Relevant fields**
- `id: uuid`
- `email: string`
- `passwordHash: string`
- `createdAt: timestamptz`
- `updatedAt: timestamptz`

**Feature rules**
- Password reset targets the login user identity, not an account record.
- Successful reset updates `passwordHash` and `updatedAt`.

## User Session

Existing entity in `sessions`.

**Relevant fields**
- `id: uuid`
- `userId: uuid`
- `accountId: uuid`
- `sessionTokenHash: string`
- `expiresAt: timestamptz`
- `lastSeenAt: timestamptz`
- `revokedAt: timestamptz | null`

**Feature rules**
- All sessions for a user are revoked when password reset succeeds.
- Revoked sessions must fail the next authorization check.

## Password Reset Token

New entity in `password_reset_tokens`.

**Fields**
- `id: uuid`
- `userId: uuid`
- `tokenHash: string`
- `expiresAt: timestamptz`
- `usedAt: timestamptz | null`
- `createdAt: timestamptz`
- `requestIp: inet | text | null`
- `requestUserAgent: text | null`

**Indexes / constraints**
- Index on `token_hash`
- Index on `user_id`
- Optional partial index to query active tokens by user

**State transitions**
- `active`: `usedAt` is null and `expiresAt > now`
- `used`: `usedAt` set during successful confirmation
- `expired`: derived from `expiresAt <= now`
- `superseded`: older rows remain unused but no longer accepted once a newer active token exists for the same user

**Feature rules**
- Store only hashed tokens.
- Confirmation accepts only the newest active token for a user.
- Successful reset marks the accepted token used and invalidates older active tokens for that user.

## Transactional Email Message

New module-level value object handled in the email module.

**Fields**
- `to: string`
- `from: { email: string; name?: string }`
- `subject: string`
- `text: string`
- `html?: string`
- `metadata?: Record<string, string>`

**Feature rules**
- Password reset composes messages through this shared shape.
- Delivery driver choice is configuration-driven and external to auth orchestration.
