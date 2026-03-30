# Admin Session Auth Contract Notes

## Intent

Replace browser-held workspace bearer token usage in the admin UI with session-authenticated workspace context while preserving multi-workspace operation.

## Contract Direction

- The account session cookie remains the browser credential for authenticated admin activity.
- Admin API routes that currently infer `workspaceId` from a bearer token move to session-authenticated workspace resolution.
- Workspace selection becomes explicit request context rather than a hidden property of a stored bearer credential.

## Expected HTTP Contract Changes

### Admin authenticated routes

- **Current**: authenticated primarily with `Authorization: Bearer <workspace-token>`
- **Target**: authenticated with session cookie plus explicit workspace selection data

Potential selection shapes during implementation:

1. Request header carrying the active workspace identifier
2. Route/query parameter for endpoints already naturally scoped by workspace
3. Session-associated active workspace endpoint for UI bootstrap and switching

## Invariants

- Requests without an authenticated account session fail as unauthorized.
- Requests with an authenticated account session but no owned workspace selection fail before business logic executes.
- Workspace switching does not require returning a reusable bearer token to browser storage.

## OpenAPI Ownership

- Any finalized auth/context change must be represented in `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.yaml` and `backend/openapi.json` are generated outputs only.
