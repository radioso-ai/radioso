# Slice 3 Notes: Outline Editor And Toggle

**Date**: 2026-06-11
**Branch**: `routine-text-composer`
**Scope**: `amendment-authoring-surface.md` §12 item 3 only.

## Delivered

- Added `frontend/lib/routine-outline.ts`, a pure client-side outline projection over `RoutineDefinitionDraft`.
- Added adapter tests covering outline state → draft → outline state identity for:
  - `default`, `llm`, `outcome`, and `counter` guards
  - handoff ends
  - a counter-bounded loop
  - action mentions inferred through an injected action catalog
  - legacy `fork`, `always`, and `fallback` normalization
  - validator diagnostic mapping to variables, step cards, branch rows, ends, and routine-level errors
- Added the per-routine **Outline / Form** toggle in the existing routines settings card.
- Preserved routine step metadata through the existing form adapter so outline labels survive outline ↔ form toggles.
- Added the outline editor surface:
  - variables block
  - ordered step cards with labels, instructions, variable/action insertion, up/down reorder, and branch rows
  - ends block with a handoff chip
  - branch-row target picker, condition field, outcome-status field, and counter limit field
- Kept routine save, validate, publish, and delete on the existing authoring API endpoints. No backend endpoints or public contracts were added.
- Updated the existing Playwright routines settings spec with an outline-path scenario for a multi-step routine, a counter branch, a handoff end, absent enum pickers in outline view, outline ↔ form data preservation, and inline branch-row diagnostics.
- Updated `docs/authoring-routines.md` minimally to describe the outline view, the retained form view, branch rows, default guard behavior, and handoff ends.

## Architecture Notes

- The outline editor is a frontend projection of `RoutineDefinitionDraft`; no document AST or text record is persisted.
- All outline inference is centralized in `frontend/lib/routine-outline.ts`.
- Step labels authored through the outline view are stored in `step.metadata.outlineLabel`, while `stableStepId` remains the durable id.
- Terminal/end labels currently project from `stableStepId` because the terminal contract has no metadata field. I did not change the backend contract in this slice. This is the one place where the UI cannot persist a distinct relabelable display label without a later contract change.
- The dashboard only exposes the registered `contact.send` action option today. The adapter supports tool/action inference through injected action options, and the unit corpus covers a tool-style action catalog entry without exposing a fake action in production UI.
- A counter branch may preserve author prose in `guardText` while `guardKind` remains `counter`; the runtime still keys on the structured counter guard.

## Boundary Review

- No backend, OpenAPI, SDK, MCP, connector, queue, or migration changes.
- No `backend/src/app/composition/` changes.
- No new runtime prompt assets.
- No sigil syntax was added to the author-facing outline UI.
- The existing form still exposes kind/guard/terminal controls by design; the no-enum-picker requirement applies to the outline view.

## Observability Review

SC-016 retirement-trigger instrumentation was skipped. Tracking "outline-authored routine" usage would require either a view-origin field in the authoring API or a frontend analytics event with a stable product telemetry sink. That is not trivially cheap in this slice and would exceed the frontend-only, no-contract-change direction.

## Validation Evidence

Red phase:

```bash
cd frontend && pnpm test -- tests/unit/routine-outline.test.ts
```

Initial result: failed as expected because `@/lib/routine-outline` did not exist.

Focused adapter/form validation:

```bash
cd frontend && pnpm test -- tests/unit/routine-outline.test.ts tests/unit/routine-form.test.ts
```

Result:

```text
Test Files  64 passed (64)
Tests       360 passed (360)
```

Full frontend unit suite:

```bash
cd frontend && pnpm test
```

Result:

```text
Test Files  64 passed (64)
Tests       360 passed (360)
```

Lint:

```bash
cd frontend && pnpm run lint
```

Result: passed with no findings.

Build attempt:

```bash
cd frontend && pnpm run build
```

Result: failed before application compilation because the sandbox has restricted network access and `next/font` could not fetch Google Fonts:

```text
getaddrinfo ENOTFOUND fonts.googleapis.com
Failed to fetch `Fraunces` from Google Fonts.
Build failed because of webpack errors
```

Playwright attempt:

```bash
cd frontend && pnpm run test:e2e -- routines-settings.spec.ts
```

Result: could not run browsers because the Playwright web server could not bind a local port in this sandbox:

```text
Error: listen EPERM: operation not permitted 127.0.0.1:3210
Process from config.webServer was not able to start.
```

Supplemental type check:

```bash
cd frontend && pnpm exec tsc --noEmit
```

Result: failed on existing frontend type errors outside this slice, including `agent-view.tsx`, `chat-view.tsx`, `quality-view.tsx`, markdown tests, embed tests, and workbench tests. No reported error referenced `frontend/lib/routine-outline.ts`, `frontend/components/dashboard/settings/assistant-routines-section.tsx`, or `frontend/tests/e2e/routines-settings.spec.ts`.

## Commit Status

No commit, push, or PR was created per EM instruction.

## EM Browser-Verification Findings (appended by EM)

- Round 1: `getByLabel("Insert action")` strict-mode violation — every step card carried an identical aria-label (accessibility defect). Fixed with per-step distinct labels on insert and branch controls.
- Round 2: a real outline-view save bug — the shared header fields displayed edited values, but outline save/validate built from stale `outline.name` / `outline.activation`. Fixed by lifting Name, Priority, and Activation trigger into shared draft header state passed into both form and outline draft-build paths (FR-016: the two views cannot desync). Also fixed FR-020 drift by rendering branch outcome status only for branches leaving action/tool outline steps; since the current action catalog does not expose enum choices in this UI, action/tool branches still use the existing free-text outcome field for now (noted as a follow-up when the catalog declares outcome enums). Added unit coverage for shared-header outline saves/toggle projection and for ignoring outcome status on chat-step branches.
- Final EM-run evidence: `pnpm exec playwright test tests/e2e/routines-settings.spec.ts` → 2 passed (outline + form journeys).

## Product-Owner UX Amendment: Dedicated Routine Editor Screen

- Investigated the dashboard route shape before editing. The Next app uses the catch-all `frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx`, with canonical URL construction and parsing centralized in `frontend/lib/dashboard-routes.ts`. Agent section navigation uses `/w/[workspaceKey]/agents/[agentId]` plus `tab`/`anchor`; existing true detail screens are explicitly added to the route parser, like knowledge documents and eval cases.
- Added explicit routine editor routes under the agent detail path: `/w/[workspaceKey]/agents/[agentId]/routines/new` and `/w/[workspaceKey]/agents/[agentId]/routines/[routineId]`. The agent sub-nav maps those routes back to the Routines section.
- Moved the routine authoring shell out of the settings list. `AssistantRoutinesSection` now renders either the list or the routed editor. The list keeps status/actions; New routine, routine row selection, and edit actions navigate to the editor screen. The editor keeps the existing Outline/Form toggle, shared draft-header ownership, diagnostics, draft assist, save, validate, publish, and draft delete behavior.
- Navigation behavior: the editor has Back to routines; first create save replaces the URL with the persisted routine id; publish replaces the URL with the published version id; draft delete returns to the list. Draft assist remains available only on the blank create route.
- Updated `docs/authoring-routines.md` after reading `docs/document-writer-prompt.md`.

Validation note for this amendment:

```bash
cd frontend && pnpm exec tsc --noEmit
```

Result: failed on existing unrelated frontend type errors in files such as `agent-view.tsx`, `chat-view.tsx`, `quality-view.tsx`, markdown tests, embed tests, and workbench tests. No reported error referenced the routine route/editor changes.

Requested validation:

```bash
cd frontend && pnpm test
```

Result: passed, 64 files / 365 tests.

```bash
cd frontend && pnpm run lint
```

Result: passed.

```bash
cd frontend && pnpm run build
```

Result: attempted, failed in the sandbox because `next/font` could not fetch `Fraunces` from `fonts.googleapis.com`:

```text
getaddrinfo ENOTFOUND fonts.googleapis.com
Failed to fetch `Fraunces` from Google Fonts.
Build failed because of webpack errors
```
