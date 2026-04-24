# Quickstart: Workspace-First Dashboard URLs

## Goal

Validate that the authenticated dashboard now uses workspace-first canonical URLs with readable public route keys while older account-scoped links continue to work through redirects.

## Preconditions

- Local backend and frontend are running.
- Test user has access to at least one organization with multiple workspaces.
- A second validation user or test setup exists for multi-organization access if available.

## Validation Steps

1. Sign in on `/` and confirm the app lands on `/w/<workspace-key>/chat` instead of an `/account/...` dashboard route.
2. Navigate to Documents, History, Settings, Users, and Evals. Confirm each route stays under `/w/<workspace-key>/...` and preserves supported query state.
3. Copy a canonical document detail URL, open it in a fresh tab, and confirm the same workspace and document view reopen.
4. Open a representative legacy link such as `/account/<account-id>/documents/<document-id>?workspace=<workspace-id>&page=2` and confirm the app redirects to the matching `/w/<workspace-key>/documents/<document-id>?page=2` URL.
5. Rename a workspace and verify previously copied canonical links still open the same workspace successfully.
6. Create a new workspace and confirm it receives a readable public route key immediately.
7. For a multi-organization user, open a canonical `/w/<workspace-key>/chat` link for a workspace in a non-current organization and confirm the app restores the correct organization and workspace context automatically.
8. Open a stale or malformed `/w/<workspace-key>/...` link and confirm the app falls back safely instead of rendering a broken state.

## Automated Validation

- Backend unit tests cover public route-key generation and workspace resolution.
- Backend integration/contract tests cover the additive authenticated resolution endpoint and auth response shapes.
- Frontend unit tests cover canonical URL building/parsing and legacy route redirects.
- Existing production build and linting continue to pass.

## Recorded Results

- `npm --prefix backend run test -- tests/unit/workspace-service.test.ts tests/unit/workspace-session-service.test.ts tests/integration/workspace-mgmt.integration.test.ts tests/integration/workspace-route-resolution.integration.test.ts`
  - Passed
- `npm --prefix backend run test -- --testTimeout=20000 tests/contract/auth.contract.test.ts tests/integration/auth.integration.test.ts`
  - Passed
- `npm --prefix backend run build`
  - Passed
- `npm --prefix frontend run test -- tests/unit/dashboard-routes.test.ts tests/unit/workspace-context.test.ts tests/unit/account-api.test.ts tests/unit/backend-proxy-route.test.ts`
  - Passed
- `npm --prefix frontend run build`
  - Passed
