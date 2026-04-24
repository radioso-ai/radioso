# Contract Notes: Workspace Route Resolution

## Purpose

Define the additive authenticated backend contract needed to restore the correct organization and workspace context from a canonical workspace-first dashboard URL.

## Endpoints

### `GET /api/v1/workspaces/resolve/:workspaceKey`

- **Authentication**: Session-authenticated user
- **Path Params**:
  - `workspaceKey`: canonical workspace public route key
- **Success Response** `200`:
  - `workspaceKey`
  - `workspaceId`
  - `workspaceName`
  - `accountId`
  - `organizationName`
  - `accessStatus: "accessible"`
- **Fallback Response** `404`:
  - Generic not-found style error when the key is stale or not accessible to the current user
- **Notes**:
  - Route must not reveal whether a workspace exists but is inaccessible beyond the existing authorization boundary.
  - This contract maps to the runtime code-first registry in `backend/src/app/http/openapi/document.ts`.

### `GET /api/v1/workspaces`

- **Change**: Existing authenticated workspace list response adds `publicRouteKey` for each returned workspace so canonical links can be built without client-side derivation.

### Auth-adjacent responses

- `POST /api/v1/auth/login`
- `POST /api/v1/account/switch`
- `POST /api/v1/account/accounts`
- `POST /api/v1/auth/invitations/:invitationToken/accept`
- `POST /api/v1/auth/password-reset/confirm`

These responses should add `workspacePublicRouteKey` so post-auth navigation can land directly on canonical workspace URLs without waiting for an extra list fetch.
