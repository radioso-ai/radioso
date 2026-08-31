# Implementation Quickstart

This is a contributor verification guide for feature 1117. The production-facing upgrade and API instructions belong in the repository documentation and release notes.

## Prerequisites

- Node.js 24, pnpm, PostgreSQL 16, and Redis for Redis-backed MCP tests.
- Install workspace dependencies from the repository root.
- Use a disposable development database. Migration 157 intentionally destroys legacy workspace-token authenticating material and cannot be reversed without restoring a backup.

## Test-first sequence

Run focused failing tests before implementing each slice, then keep them green:

```bash
cd backend
pnpm run test:unit -- machineAccess
pnpm run test:integration -- apiAccess
pnpm run test:contract -- apiAccess
```

For MCP runtime behavior:

```bash
cd packages/radioso-mcp-server
pnpm test
pnpm run smoke:all
```

For the dashboard:

```bash
cd frontend
pnpm test
pnpm run test:e2e -- api-access-settings.spec.ts
```

## Manual acceptance path

1. Upgrade a disposable installation containing a legacy workspace token. Confirm migration 157 records a safe tombstone and removes all verifier/ciphertext material.
2. Confirm configured MCP stores complete their purge before readiness; make the store unavailable once and confirm readiness fails closed and retry succeeds later.
3. Sign in as a member, create a member-ceiling personal token, copy/acknowledge it, and verify no secret is retained in browser local/session storage.
4. Use the personal token on an explicitly eligible member API. Verify an administrator API and every lifecycle endpoint deny bearer-only access.
5. Demote or remove the user. Confirm the next request observes the live role or rejects the ended tenure; reinvitation must not revive the old token.
6. Sign in as an administrator/owner, create a service account plus first credential, add a second credential, and confirm both authenticate as the same stable principal with distinct credential IDs.
7. Revoke one service credential, change the account role, disable/re-enable it, then archive it. Confirm sibling isolation, live role changes, suspension, selective restoration, and permanent archive invalidation.
8. Rotate a credential twice concurrently at one revision. Confirm exactly one new secret, immediate predecessor invalidation, unchanged absolute expiry, and a conflict without secret for the loser.
9. Verify safe paginated metadata, quotas, expiry warnings, audit attribution, bounded diagnostic fields, and absence of secret/verifier values in logs, traces, events, or API responses.
10. Present personal and service credentials to merged MCP, standalone exchange, stdio preflight, and agent-converse. Confirm generic rejection in every mode.

## Generated contracts

Generate from code-first backend definitions, then synchronize the published SDK snapshot:

```bash
cd backend
pnpm run openapi:generate

cd ../typescript-sdk
pnpm run sync
pnpm run build
pnpm test
```

Use the actual package script reported by `pnpm run` if the OpenAPI generator is named differently; never hand-edit `backend/openapi.json`, `backend/openapi.yaml`, or SDK generated files.

## Final verification

```bash
pnpm run ci:local -- origin/main
```

Use `pnpm run ci:local -- --all` if the final diff reaches beyond the planned backend/frontend/MCP/SDK/docs surfaces. Record the exact command and outcome in the pull request.
