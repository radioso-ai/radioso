# Contract: Inbound Operator OAuth And Dashboard Lifecycle

All OAuth endpoints are on the Radioso application origin. JSON dashboard
endpoints are represented in the code-first OpenAPI registry. Standard OAuth
form/redirect endpoints are conformance-tested even when OpenAPI cannot fully
model their redirect responses.

## Discovery

- `GET /.well-known/oauth-authorization-server`
- Returns issuer, authorization/token/revocation endpoints,
  `client_id_metadata_document_supported: true`, and, only when the
  evidence-gated bounded DCR profile is implemented and enabled, a registration endpoint,
  `authorization_code` and `refresh_token`, S256, supported client methods, the
  four tool scopes, and `offline_access`.
- Dynamic registration is neither returned nor enabled unless a frozen named
  client fixture proves it is required and the bounded DCR contract is present.

## Authorization

- `GET /api/v1/operator-mcp/oauth/authorize`
- Required: `response_type=code`, `client_id`, exact `redirect_uri`, `scope`,
  `state`, S256 `code_challenge`, `code_challenge_method=S256`, exact `resource`.
- Validates/pins the client and creates a five-minute transaction, then redirects
  to `/oauth/operator-mcp/consent?transaction=<opaque-handle>`.
- The transaction records an immutable normalized client metadata snapshot ID
  and digest. Consent, code, grant, and credentials retain that same identity.
- Errors with a trusted redirect use OAuth error parameters plus the original
  state. Errors before redirect trust is established return a safe local error.

## Consent transaction

- `GET /api/v1/operator-mcp/oauth/transactions/{transactionId}` — session only;
  returns safe client identity, requested scopes, redirect host, current user,
  and workspaces the current account session may authorize.
- `POST /api/v1/operator-mcp/oauth/transactions/{transactionId}/decision` —
  session + non-simple CSRF header; body contains `decision`, exactly one
  `workspaceId` when approving, approved tool scopes, and offline-access choice.
  Returns the exact client redirect URL after an atomic decision.

## Token

- `POST /api/v1/operator-mcp/oauth/token` (`application/x-www-form-urlencoded`).
- Authorization-code request: `grant_type`, `code`, `client_id`, exact
  `redirect_uri`, PKCE `code_verifier`, exact `resource`, optional equal/narrower
  `scope`.
- Refresh request: `grant_type`, `refresh_token`, `client_id`, exact `resource`,
  optional equal/narrower `scope`.
- Success: Bearer access token, `expires_in <= 900`, exact scope; refresh token
  only when `offline_access` was approved.
- The exact returned/narrowed scopes are persisted on the access row and refresh
  lineage. Admission intersects them with the current grant and never reloads a
  broader grant scope as if it had been issued to that credential.
- Failure: standard safe OAuth error without account/workspace/token detail.

## Revocation

- `POST /api/v1/operator-mcp/oauth/revoke` accepts an access or refresh token and
  returns success for known or unknown tokens without leaking validity.

## Dashboard setup

- `GET /api/v1/workspaces/{workspaceId}/operator-mcp/setup` is owned by
  `operatorMcpSetup` and returns availability, canonical resource, and
  verified/unavailable client setup artifacts. It does not read grants.

## Dashboard grants

- `GET /api/v1/workspaces/{workspaceId}/operator-mcp/grants` is owned by
  `operatorMcpAuthorization` and returns the current user's grants plus workspace
  grant inventory only when authorized.
- `GET /api/v1/workspaces/{workspaceId}/operator-mcp/grants/{grantId}` returns
  safe detail only.
- `POST /api/v1/workspaces/{workspaceId}/operator-mcp/grants/{grantId}/revoke`
  requires session, workspace context, CSRF, and self-or-owner/admin authorization.

Own grants are visible and revocable to their user. Workspace-wide inventory
and revocation require the existing owner/admin account role plus the relevant
workspace access; no request parameter can elevate a member into the admin view.

No response contains a reusable credential, authorization code, proof verifier,
client secret, tool input, tool output, prompt, or customer content.
