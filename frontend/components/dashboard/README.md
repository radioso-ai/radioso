# Dashboard Components

Dashboard components own the authenticated product UI: navigation, workspace
views, document management, chat surfaces, settings, activity diagnostics,
quality and Audience Pulse views, usage, and users.

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
- `app-sidebar.tsx` and `area-subnavs.tsx`: sidebar navigation, agent selection and creation, and configured agent channel links. `frontend/lib/agent-channel-catalog.ts` maps channel configuration into the compact list.
- `agent-view.tsx`: agent shell and persistent settings owner across cockpit tabs. It retains unsaved private instructions while Test Chat uses the real async save port in `frontend/lib/agent-draft-save-port.ts`.
- `agent-revision-test-chat.tsx`: immutable single/comparison tests, proactive greeting startup when enabled, lazy first-send when disabled, history adoption, and revision eval evidence. Each test view renders in a card with a labelled revision header; the single header also offers the direct **Compare versions** action, and comparison cards expose a visible close control that retains the other version as a single private thread. Its title-row overflow menu uses the shell’s DOM portal target and does not switch comparison to single chat. Conversation rendering reuses `chat-message-thread.tsx`, while context and eval controls open on demand. `test-execution-history-view.tsx` reads paginated private execution history through `frontend/lib/api-agent-revisions.ts`; the state helper preserves recorded turn/attempt identities, and `frontend/lib/agent-revision-test-chat-session.ts` keeps the agent-scoped session alive across dashboard route remounts.
- `workbench/chat-workbench.tsx`: the operator test-chat workbench (live chat +
  copyable conversation id + selectable turn inspector + recent test sessions).
  `chat-view.tsx` is a thin alias over it; the workbench owns its own layout so it
  can also mount inside a drawer/sheet.
- `turn-inspector/turn-diagnostics-panel.tsx`: the shared turn-diagnostics panel
  reused by both the workbench inspector and the activity `conversation-drawer.tsx`
  (driven by a surface-neutral `TurnDiagnosticsInput`) — change turn diagnostics
  here, not in either caller.
- `documents-view.tsx` and `documents/`: document list, import, crawl, edit, and
  inspection UI.
- `audience-pulse-view.tsx`: saved topic, grounding-gap, and content-recommendation
  dashboard, with evidence and document-draft handoffs.
- `settings-view.tsx` and `settings/`: assistant, retrieval, ingestion, provider,
  and channel settings.
- `activity-*`: retrieval and activity diagnostics views.

## Common Change Paths

- Dashboard route or workspace switching: `dashboard-shell.tsx`,
  `workspace-switcher.tsx`, `frontend/lib/dashboard-routes.ts`.
- Chat UI: `workbench/chat-workbench.tsx` (+ `chat-view.tsx` alias),
  `chat-message-thread.tsx`, `conversation-drawer.tsx`, `chat-citations.tsx`.
- Turn diagnostics (both surfaces): `turn-inspector/turn-diagnostics-panel.tsx`.
- Test history: Test Chat combines durable immutable executions with earlier workbench sessions. The workbench's **History** mode renders
  `workbench/test-sessions-view.tsx` (an activity-style table of
  `chatApi.listChatHistory({ sourceScope: 'operator_test' })` that opens the shared
  `ConversationDrawer`). Dashboard test chats (`source_channel` = `authenticated_chat`)
  are excluded from Activity by the server default, so the workbench is where they
  surface. Sending a turn to the eval/replay workbench is the per-turn
  `SendToEvalAction` (flask icon) in `chat-message-thread.tsx`.
- Continue a real conversation as a test: `workbench/continue-in-test-chat-action.tsx`
  (in the `ConversationDrawer` header) calls `chatApi.forkConversation` — the backend
  copies the thread into a new `authenticated_chat` conversation — then navigates to
  the agent chat tab with `agentChatConversationId` (a `dashboard-routes` param). The
  workbench adopts it via `useChatSession().adoptConversation` (`lib/chat-context.tsx`),
  loading the forked thread and continuing live. Original conversation is untouched.
- `ChatWorkbench` is a reusable component with a `shell: 'page' | 'drawer'` prop — the
  same live chat body renders inside the full-page `DashboardPage` or, via
  `workbench/chat-workbench-drawer.tsx`, inside a right-side `Sheet`. Page-context props
  (`onOpenDocument`, `onboarding`) are optional so it drops into either host.
- Test an unpublished routine: **Test draft** on a saved draft in
  `settings/assistant-routines-section.tsx` opens `ChatWorkbenchDrawer` in place (no
  navigation) with `previewRoutineIds={[draftId]}`. `ChatWorkbench` passes them into
  `useChatSession(..., { previewRoutineIds })`, which rides every send to `/assistant/chat`;
  the backend makes those draft definitions eligible for the turn (operator-only — public
  chat has no such field). The draft-test session uses a distinct session key so its turns
  never mix into the normal test chat. A deep link `?tab=chat&chatPreviewRoutine=<id>`
  (`dashboard-routes` param `agentChatPreviewRoutineId`) does the same test full-page.
- Settings UI: `settings-view.tsx`, `settings/`, and settings docs sources.
- Documents UI: `documents-view.tsx`, `document-sources-view.tsx`, `documents/`.
- Audience Pulse: `audience-pulse-view.tsx`, `frontend/lib/api-audience-pulse.ts`,
  `frontend/lib/audience-pulse-draft-seed.ts`,
  `frontend/lib/audience-pulse-evidence-handoff.ts`, `dashboard-routes.ts`, and
  `documents-view.tsx` / `conversation-drawer.tsx` for handoffs.
- Shared table/page patterns: `shared/`.

## Tests

Prefer Playwright for visible user journeys and component/unit tests for state
transitions or data transforms:

- `cd frontend && pnpm test -- tests/unit/chat-message-thread.test.tsx`
- `cd frontend && pnpm test -- tests/unit/settings-tab-metadata.test.ts`
- `cd frontend && pnpm run test:e2e -- assistant-history.spec.ts`
- `cd frontend && pnpm run test:e2e -- assistant-retrieval-settings.spec.ts`
- `cd frontend && pnpm run test:e2e -- audience-pulse.spec.ts`
