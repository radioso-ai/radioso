# SDK Surface Contract: Radioso TypeScript SDK v1

## Contract Source of Truth

- The source of truth for HTTP request and response shapes is `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.json` and `backend/openapi.yaml` are generated outputs and must be regenerated from the code-first registry.
- `typescript-sdk/openapi/radioso.json` and `typescript-sdk/openapi/radioso.yaml` are synced package snapshots derived from the backend artifacts and must not be hand-edited.

## Authentication Expectations

- The v1 SDK is token-first.
- Operations intended for SDK consumers must be documented with token-based auth semantics in the backend contract.
- Session-cookie-only and browser-admin-only operations are excluded from the v1 SDK surface.

## Initial SDK Surface Categories

- **Included**:
  - token-authenticated workspace-scoped operations that are explicitly intended for external integrations
  - document operations intended for API-token use
  - supported retrieval or general settings operations intended for API-token use
  - standard chat operations intended for API-token use
  - streaming chat operations intended for API-token use
- **Excluded**:
  - login and registration flows built around browser session cookies
  - admin-only token reveal flows
  - browser-session management and first-party dashboard bootstrap flows
  - undocumented or internal-only endpoints

## SDK Runtime Expectations

- Standard request/response operations are generated from the backend contract.
- Streaming chat uses a handwritten typed adapter layered on the generated transport.
- The SDK normalizes transport and backend failures into a consistent SDK error surface.

## Validation Expectations

- Contract-refresh validation must fail when backend contract snapshots and SDK-generated artifacts drift.
- Quickstart validation must cover token configuration, one standard request flow, and one streaming chat flow.
