# Dashboard Components

Dashboard components own the authenticated product UI: navigation, workspace
views, document management, chat surfaces, settings, activity diagnostics,
quality and Audience Pulse views, usage, users, and the signed-in person's
profile.

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
- `agent-revision-test-chat.tsx`: immutable single/comparison tests, proactive greeting startup when enabled, lazy first-send when disabled, history adoption, and revision eval evidence. Each test view renders in a card with a labelled revision header; the single header also offers the direct **Compare versions** action, and comparison cards expose a visible close control that retains the other version as a single private thread. Its title-row overflow menu uses the shell’s DOM portal target and does not switch comparison to single chat; the same menu's **Run skills for real** checkbox chooses the private test's per-execution skill-effects policy (`suppressed` keeps outward-effect skills — external tools, webhooks, email, Slack, notify — off; retrieval always runs), frozen at start like test values, with a `Skills run for real` chip on each test card while it is on. Conversation rendering reuses `chat-message-thread.tsx`, while context and eval controls open on demand. `test-execution-history-view.tsx` reads paginated private execution history through `frontend/lib/api-agent-revisions.ts`; the state helper preserves recorded turn/attempt identities, and `frontend/lib/agent-revision-test-chat-session.ts` keeps the agent-scoped session alive across dashboard route remounts, including the skill-effects choice.
- `turn-inspector/turn-diagnostics-panel.tsx`: the shared turn-diagnostics panel
  reused by the Test Chat debug sheet and the activity `conversation-drawer.tsx`
  (driven by a surface-neutral `TurnDiagnosticsInput`) — change turn diagnostics
  here, not in either caller.
- `turn-flow-graph.tsx` draws the **Flow** view that `turn-flow-overlay.tsx` and the
  eval flow open. `frontend/lib/turn-flow.ts` decides what it shows: phase bands
  (Understand, the skill or routine that ran, Answer), steps in execution order with
  a tone and a measured duration, and capability steps folded under their skill node.
  Stage labels and summaries come from `frontend/lib/activity-stage-presentation.ts`,
  shared with the stage list in `activity-trace-graph.tsx`. Change what a step says
  in those two modules; the graph component only draws.
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
- Chat UI: `agent-revision-test-chat.tsx` is the one operator test surface (the
  agent's **Test Chat** tab, backed by `/agents/:id/test-executions`), rendering
  `chat-message-thread.tsx`; `conversation-drawer.tsx` and `chat-citations.tsx` are the
  activity-side readers.
- Turn diagnostics (both surfaces): `turn-inspector/turn-diagnostics-panel.tsx`.
- Test history: Test Chat's **History** view lists durable immutable executions
  (`test-execution-history-view.tsx`, reopened through `reopenExecution`) above
  `workbench/test-sessions-view.tsx` (an activity-style table of
  `chatApi.listChatHistory({ sourceScope: 'operator_test' })` that opens the shared
  `ConversationDrawer`). Dashboard test chats (`source_channel` = `authenticated_chat`)
  are excluded from Activity by the server default, so Test Chat is where they
  surface. Sending a turn to the eval/replay workbench is the per-turn
  `SendToEvalAction` (flask icon) in `chat-message-thread.tsx`.
- Continue a real conversation as a test: `workbench/continue-in-test-chat-action.tsx`
  (in the `ConversationDrawer` header) reads the agent's revision state, starts a
  single-mode test execution on the live published revision with
  `seedConversationId` set and no test values (`agentRevisionsApi.startTest`) — the
  backend copies the source thread into the side's history and carries its routine
  state, without a greeting — then navigates to the agent's Test Chat tab with
  `agentTestExecutionId` (`dashboard-routes` param, query key `testExecution`). The
  backend's `seededTurnCount` on the reopened detail (greater than zero for a seeded
  test) is what picks the "continuing a copy" notice; the route carries only the id.
  The original conversation is untouched.
- The URL is the only place that says which test is open in Test Chat, not a one-shot
  open command: `agentTestExecutionId` (query `testExecution`) and `agentTestChatView`
  (query `view=history`) together form `frontend/lib/test-chat-open-route.ts`'s
  `TestChatRoute`, built in `agent-view.tsx` and passed to
  `agent-revision-test-chat.tsx` as the `route` prop. `agent-view.tsx`'s
  `navigateTestChat` is the one place that turns a navigation decision into a shallow
  `window.history` entry (push, replace, or return — `TestChatNavigation`), never a
  server round trip; Test Chat calls it through the `onNavigate` prop and otherwise
  knows nothing about browser-history mechanics. A pushed history entry gets a
  `history.state` marker so leaving it can step back instead of bouncing between chat
  and history, surviving Back and Forward.
  Two effects in `agent-revision-test-chat.tsx` reconcile the route against what is
  loaded, using the pure decisions in `test-chat-open-route.ts`: `followRoute` reacts
  to the route's id — adopting a loaded test back into an empty URL (returning to the
  tab, Back onto an empty entry), opening a different id (fetching it, with an
  "Opening this test…" status replacing the thread and composer while it matches
  `openingId`, so a send cannot race it), or rejecting one that is not a UUID
  (`isValidTestExecutionId`), reporting in `linkOpenFailure`, which a greeting's start
  does not clear; `routeIdForLoaded` reacts to what finishes loading — starting a
  test, reopening one, retaining a comparison side, a saved-draft refresh, or New
  chat's clear — and writes its id (or clears it) with a replace, so no entry point
  above has to remember to write the URL itself. Reloading the page, or returning to
  a tab whose session cache still holds a loaded test, reopens or adopts the same
  test rather than losing it.
- Share a saved test: `agent-view.tsx` passes `testExecutionHref` (the
  `?testExecution=<id>` link above) into Test Chat, which backs the **Copy link to
  this chat** menu item and the per-row link button in `test-execution-history-view.tsx`.
  Both copy through `hooks/use-copy-dashboard-link.ts` (over `lib/copy-dashboard-link.ts`),
  which keys its feedback to the copied test and hands back the URL for `UncopiedLink`
  to show when the page has no clipboard access (a plain-HTTP host). Anyone with
  `workspace.agents.manage` in the workspace can open the link. The history list labels
  each test by its clipped `firstMessage` and shows its `turnCount` as **Messages**.
- Conversation history is route state, not component state: `agentTestChatView` decides
  whether `agent-revision-test-chat.tsx` shows the chat or `TestExecutionHistoryView`,
  whose `onOpen(executionId)` only names the test to open — it fetches nothing itself,
  pushing the id into the route for the reconcile effects above to fetch. Opening a
  saved test always shows the chat, so the route drops `view` when both are present,
  and `buildAgentSectionHref` drops both Test Chat params so section links land on the
  section.
- Test an unpublished routine: **Test draft** on a saved draft in
  `settings/assistant-routines-section.tsx` navigates to the agent's Test Chat tab
  (`agent-revision-test-chat.tsx`), whose Draft candidate is built from the agent draft
  snapshot and so already carries the routine draft; the button is disabled while the
  routine is disabled because the snapshot's activation set leaves it out.
- `agent-revision-test-chat.tsx` loads its revision list through `assembleTestableRevisions`:
  revision state and the published list are required, the Draft candidate is best-effort
  (a refused candidate leaves published revisions testable and shows the refusal in the
  error banner), and a `draft_clean` state lists published revisions only. A cached
  session is checked against the current draft generation on mount. `TurnFlowOverlay`
  (`turn-flow-overlay.tsx`) is a modal Radix `Dialog` layer so the Turn debug sheet under
  it survives clicks on the graph.
- Settings UI: `settings-view.tsx`, `settings/`, and settings docs sources.
- Agent **Skills → Manage MCP connections** opens `settings/skills/McpServersPanel.tsx`,
  which hosts outbound targets through `McpConnectionsSection.tsx`. The capability
  picker opens the same panel and refreshes its caller's catalog on close.
  **Channels → MCP** owns inbound
  client access through `settings/mcp-channel-card.tsx`. The shared credential
  list keeps revoked access in a collapsed history disclosure.
- Documents UI: `documents-view.tsx`, `document-sources-view.tsx`, `documents/`.
- Audience Pulse: `audience-pulse-view.tsx`, `frontend/lib/api-audience-pulse.ts`,
  `frontend/lib/audience-pulse-answer-status.ts`,
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
