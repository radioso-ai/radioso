# Frontend Library

`frontend/lib/` owns client-side adapters, state providers, routing helpers,
storage helpers, validation, and small pure utilities used by frontend
components.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../docs/architecture/code-map.md).

## Boundaries

Library code knows about backend API payloads, client-side session and workspace
state, browser storage, routing helpers, and typed transforms.

Library code should not own visual layout, dashboard component composition, or
backend domain behavior. Components should call these helpers instead of
constructing ad hoc fetches.

## Read First

- `api-client.ts`: shared request behavior.
- `api-*.ts`: endpoint-specific adapters.
- `api-types.ts`: shared frontend API types.
- `auth-context.tsx`, `workspace-context.tsx`, `chat-context.tsx`: React
  providers for major client state.
- `dashboard-routes.ts`: dashboard route helpers.
- `embed-widget.ts` and `radioso-embed-launcher.js`: website embed behavior.

## Common Change Paths

- API behavior: add or update the relevant `api-*.ts` adapter and keep types
  aligned with backend contracts.
- Auth/session/workspace state: update context providers and corresponding unit
  tests.
- Dashboard navigation: `dashboard-routes.ts`,
  `dashboard-workspace-sync.ts`, and dashboard components.
- Embedded/public chat: `api-public-chat.ts`, `public-chat-session-handoff.ts`,
  `embed-widget.ts`.

## Tests

Focused starting points:

- `cd frontend && pnpm test -- tests/unit/api-types.test.ts`
- `cd frontend && pnpm test -- tests/unit/auth-api.test.ts`
- `cd frontend && pnpm test -- tests/unit/workspace-context.test.ts`
- `cd frontend && pnpm test -- tests/unit/embed-widget.test.ts`

Use Playwright when behavior is only meaningful through a visible user journey.
