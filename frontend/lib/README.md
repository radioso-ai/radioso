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
- `api-storage.ts`: keeps the active workspace ID and public route key together
  in each tab's session storage. Local storage remembers the default for a fresh
  tab as one serialized value; request adapters use the tab's selection through
  the shared getters.
- `api-types.ts`: shared frontend API types.
- `auth-context.tsx`, `workspace-context.tsx`: React providers for major client
  state; `anonymous-chat-context.tsx` is the public embed's chat session.
- `dashboard-routes.ts`: dashboard route helpers.
- `teammate-label.ts`: how operator surfaces name a teammate — display name,
  else email. Visitor-facing surfaces never fall back to an email.
- `operator-actions.ts`: who holds a conversation — keyed by the owning user,
  compared to the signed-in user for "mine" — and what the response view offers:
  reply, and Assign or Reassign (Me first, never the current owner).
- `reply-attribution.ts`: who a human reply's badge names — the replying
  teammate (`operatorLabel`) on operator surfaces, only the signature
  (`operatorDisplayName`) on visitor surfaces.
- `agent-draft-save-port.ts`: the agent-scoped async bridge that lets Test Chat
  await the mounted editor's real private draft save before execution, and
  `AGENT_DRAFT_SAVED_EVENT`, the window event a draft save, a publication, or Ray
  applying a greeting proposal sends.
- `agent-revision-test-chat-session.ts`: the in-memory Test Chat session store,
  keyed by workspace and agent, that keeps selected revisions, sample values,
  composer text, transcripts, and in-flight updates available while dashboard
  routes remount. Workspace lifecycle owns disposal when the active workspace
  changes.
- `embed-widget.ts` and `radioso-embed-launcher.js`: website embed behavior.
  `embed-locale-packs.ts` owns the built-in translations; the launcher cannot
  import it, so `embed-launcher-script.ts` writes the packs and copy keys into
  the script as `/radioso-embed.js` serves it.
- `routine-consent-editor.ts`: a routine's consents in the Document view — the
  sensitive fields each covers, the decline choice, and the wording per language,
  edited through the exact-greeting variant transitions — plus where each is asked
  and where a validation finding belongs. `routine-document-edits.ts` keeps them in
  step when a field is renamed, removed, or set back to normal.
- `privacy-notice.ts`: the agent's privacy notice on the visitor surfaces — which
  language's notice a visitor sees (the backend's rule: their language, else
  English, else the first), and the Privacy notice card's form, which saves only
  complete rows. `anonymous-chat-context.tsx` reports the shown notice's version
  with the message that starts a conversation.

## Common Change Paths

- API behavior: add or update the relevant `api-*.ts` adapter and keep types
  aligned with backend contracts.
- Auth/session/workspace state: update context providers and corresponding unit
  tests.
- Dashboard navigation: `dashboard-routes.ts`,
  `dashboard-workspace-sync.ts`, and dashboard components.
- Audience Pulse: `api-audience-pulse.ts` reads saved reports, starts explicit
  refreshes, and opens evidence; `audience-pulse-draft-seed.ts` and
  `audience-pulse-evidence-handoff.ts` keep transient recommendations and evidence
  out of the URL.
- Embedded/public chat: `api-public-chat.ts`, `public-chat-session-handoff.ts`,
  `public-chat-suggestion.ts` (what a clicked suggestion chip sends, and which chips a restored thread keeps), `embed-widget.ts`.

## Tests

Focused starting points:

- `cd frontend && pnpm test -- tests/unit/api-types.test.ts`
- `cd frontend && pnpm test -- tests/unit/auth-api.test.ts`
- `cd frontend && pnpm test -- tests/unit/workspace-context.test.ts`
- `cd frontend && pnpm test -- tests/unit/embed-widget.test.ts`
- `cd frontend && pnpm test -- tests/unit/api-audience-pulse.test.ts tests/unit/audience-pulse-draft-seed.test.ts tests/unit/audience-pulse-evidence-handoff.test.ts`

Use Playwright when behavior is only meaningful through a visible user journey.
