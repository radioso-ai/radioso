# Auth and Organization Creation Contract

## `GET /api/v1/auth/registration`

Unauthenticated, read-only response:

```json
{
  "available": true
}
```

- Empty OSS deployment: `true`.
- Initialized or currently reserving OSS deployment: `false`.
- Enterprise deployment: `true`.

## `POST /api/v1/auth/register`

The existing request and `201` response remain unchanged. Initialized OSS returns `403` with the standard error envelope and a stable invitation-required message. Rejection happens before account, user, membership, workspace, hook, email, or session mutation.

For an allowed signup, the account, user, owner membership, and default workspace form one PostgreSQL transaction. Interruption before commit leaves none of those records; interruption after commit leaves the complete core organization graph. Extension hooks, audit, email, and HTTP response handling remain outside that transaction.

## `POST /api/v1/account/accounts`

The existing request and `201` response remain unchanged. OSS returns `403` before mutation. Enterprise keeps the existing `429 rate_limit_exceeded` response at the monthly cap.

Enterprise additional creation uses the same core transaction for account, owner membership, and default workspace while reusing the signed-in user. Session switching, extension hooks, and audit retain their existing post-transaction behavior.

## Invitation and workspace contracts

Invitation inspection/acceptance and workspace creation contracts do not change. They do not consult organization-creation policy.

## Message-queue impact

No impact: document dispatch, AMQP payloads, retries, queue tests/docs, SDK contracts, MCP contracts, and connector contracts are unchanged.
