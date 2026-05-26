# Dashboard Components

Dashboard components own the authenticated product UI: navigation, workspace
views, document management, chat surfaces, settings, activity diagnostics,
quality views, usage, and users.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../docs/architecture/code-map.md).

## Boundaries

Dashboard components know about visible UI state, user interactions, view-level
composition, and presentation-specific formatting.

Dashboard components should not duplicate backend domain rules, hand-roll API
fetching, or encode behavior that belongs in `frontend/lib/` adapters or backend
services.

## Read First

- `dashboard-shell.tsx`: top-level dashboard layout.
- `app-sidebar.tsx`: navigation and section switching.
- `chat-view.tsx`: authenticated chat surface.
- `documents-view.tsx` and `documents/`: document list, import, crawl, edit, and
  inspection UI.
- `settings-view.tsx` and `settings/`: assistant, retrieval, ingestion, provider,
  and channel settings.
- `activity-*`: retrieval and activity diagnostics views.

## Common Change Paths

- Dashboard route or workspace switching: `dashboard-shell.tsx`,
  `workspace-switcher.tsx`, `frontend/lib/dashboard-routes.ts`.
- Chat UI: `chat-view.tsx`, `chat-message-thread.tsx`,
  `conversation-drawer.tsx`, `chat-citations.tsx`.
- Settings UI: `settings-view.tsx`, `settings/`, and settings docs sources.
- Documents UI: `documents-view.tsx`, `document-sources-view.tsx`, `documents/`.
- Shared table/page patterns: `shared/`.

## Tests

Prefer Playwright for visible user journeys and component/unit tests for state
transitions or data transforms:

- `cd frontend && pnpm test -- tests/unit/chat-message-thread.test.tsx`
- `cd frontend && pnpm test -- tests/unit/settings-tab-metadata.test.ts`
- `cd frontend && pnpm run test:e2e -- assistant-history.spec.ts`
- `cd frontend && pnpm run test:e2e -- assistant-retrieval-settings.spec.ts`
