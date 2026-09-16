# Implementation Plan: Exact Words — Slice A (Exact Greeting)

**Branch**: `custom-greeting-action-chips` | **Date**: 2026-09-14 | **Spec**: specs/1150-exact-words/spec.md

**Scope**: Slice A only — exact greeting with language variants and chips (US1, US3/US4 for greetings, US5). Routine replies (Slice B / US2) are out of scope; the shared exact-output contract built here must admit Slice B without rework (no greeting-specific types in the shared contract).

## Summary

Today `proactiveGreetingEnabled` (bool), `greetingInstruction`, and `assistantDefaultLocale` live in the opaque `agents.greeting_settings` JSONB column, are edited live via `PUT /agents/:id`, and bootstrap (`chatBootstrapService.ts`) always reserves usage and calls the LLM on a cache miss. Slice A adds Exact greeting content (variants + 0–5 chips) authored in the same place, validated, previewed, and delivered from a published agent revision snapshot (FR-013). `agentRevisionSnapshotSchema` (`agentRevision.ts`) covers `customInstruction`, `directives`, `routines`, `contextVariableEnablements`, `agentSkills` — greeting is not in it; Slice A adds an optional `greeting` key, written through the existing `withAgentDraftMutation` helper (`agentDraftMutation.ts`) the same way routines and agent skills project into the draft.

## Technical Context

TypeScript/Node 24/Express backend; TS 5.7/React 19/Next 16 frontend; PostgreSQL 16. No new tables or columns — `agents.greeting_settings`, `agent_drafts.snapshot`, `agent_revisions.snapshot` are pre-existing JSONB validated by Zod. Vitest + Playwright. TDD: failing tests first. New shared-domain module under `backend/src/shared/domain/`.

## Constitution Check

Authored-copy exception applies (spec §Constitution). No stack/provider/secret/storage change. Contract changes ship with regenerated OpenAPI, `typescript-sdk` sync, and MCP server sync in the same change. Message-queue impact: none (below).

## Findings Against Current Code

- **F1** `greetingInstruction` is not read by the bootstrap prompt: `buildBootstrapPrompt()` in `chatBootstrapService.ts` uses only `agent.name` and `agent.customInstruction`. It is wired into `authoredDirectiveService.ts:248` and legacy workspace↔agent sync only. Pre-existing gap; out of scope (Automatic must stay unchanged, FR-014). Separate ticket.
- **F2** Greeting settings are live-edited and outside the revision system: `PUT /agents/:agentId` (`agentRoutes.ts:651`) → `agentInputSchema.ts` → `domain.ts:normalizeAgentInput` → `agentRepository.ts:toGreetingSettings`/`mapAgent`. `agentRevisionRoutes.ts:34` reads `proactiveGreetingEnabled` off the live row.
- **F3 (decision)** Off stays a live kill switch (`proactiveGreetingEnabled`, unchanged). Exact is enabled by *publishing* content: the versioned snapshot carries `greeting.exactWordsEnabled` + `greeting.exactContent`. Effective mode = `off` if `!proactiveGreetingEnabled`; else `exact` if the published revision has `exactWordsEnabled && exactContent`; else `automatic`. Enabling and content travel atomically, so a mode flip can never point at absent content. FR-002's "switching modes preserves inactive content" = `exactWordsEnabled: false` with content retained.
- **F4 (verification b) CONFIRMED** No context variables reach bootstrap (`startConversation` input has none; resolution runs only inside a turn via `chatSessionPreparer`/`chatTurnAssembly`). Bootstrap supplies an empty available-reference map, so any `{{…}}` in greeting text is rejected as unknown by the shared validator. No greeting-specific carve-out.
- **F5 (verification c) CONFIRMED as a required change** `chatBootstrapService.ts:115-128` reserves usage and calls `chatGateway.answer` on any cache miss. Exact mode must branch out before that block.
- **F6 (verification d)** No `greetingMode` enum is persisted; the three-way UI choice is derived (F3). The OpenAPI boolean `proactiveGreetingEnabled`, `isAgentBootstrapActive` (`domain.ts:857`), and the frontend Switch keep their meaning.
- **F7** No SQL migration: JSONB-only key additions, Zod-validated. No `db:types`/`db:schema` regen.
- **F8** Reuse `withAgentDraftMutation(db, workspaceId, agentId, op)` (used by `routineDefinitionRepository.ts:843`, `agentSkills/repository.ts:333`) to write the draft snapshot's `greeting` key under the per-agent advisory lock. `greeting` is optional on the snapshot schema (precedent: `agentSkills`); absent = automatic.
- **F9** Chip contract is small: `ChatBootstrapResponse` (`chatResponses.ts:66`) already inherits `suggestions?: ChatSuggestion[]`, and `chatResponseCoreShape` (`assistantHistorySchemas.ts:175,569`) already declares `suggestions`. Real deltas: `id: z.string().optional()` on `ChatSuggestionSchema` (~L65-73) and its TS mirror; bootstrap populates it. `action.kind === "ask_followup"` (`chatHistoryService.ts:492`) is the FR-008 click behavior — no new action kind.
- **F10** Ray: `propose_agent_setting` (`operatorCopilot/tools/agents.ts:279-330`) validates `settingKey` against `agentInputFieldSchemas` (`agentInputSchema.ts:22+`). Exact content is versioned, not a live setting, so it needs the draft-authoring route, not `propose_agent_setting`. Ray parity for Slice A = the existing draft-proposal path used for directives (`propose_*` → draft), applied to `greeting`; `propose_agent` (creation from website analysis) explicitly excludes exact content — stated coverage-map exclusion.
- **F11** No AMQP/worker references in `modules/chat` or `modules/agents` greeting/bootstrap paths; bootstrap is synchronous HTTP. Message-queue impact: none.

## Design Discipline

**Knowledge**
- `backend/src/shared/domain/exactContent.ts` (new): `ExactContentItem` / variant / chip types; locale selection (exact tag → base → agent default locale, never a regional sibling); reference validation against a caller-supplied available-reference map; limits (FR-009). Knows nothing of HTTP, Postgres, agents, routines, bootstrap, or providers. Slice B's routine runner consumes it unchanged.
- `agentRevision.ts`: shape of a released agent, now with optional `greeting`. Does not resolve.
- `chatBootstrapService.ts`: starts a conversation, reads the published revision, calls the resolver, applies the outcome. Does not implement fallback or validation.
- Composition wires the greeting draft writer and the revision reader into bootstrap; it decides nothing.

**Ports**
- `resolveExactContent(item, { requestedLocale, agentDefaultLocale, availableReferences }) → { kind: "resolved", locale, fallbackApplied, body, chips[] } | { kind: "unavailable", reason } | { kind: "conflict", reason }`.
- `validateExactContentItem(item, { agentDefaultLocale, availableReferenceKeys }) → ValidationResult` — used identically by save, candidate validation, and preview (FR-007/FR-012).
- Draft writes go through `withAgentDraftMutation`; no new port.

**Dependency direction** `shared/domain` ← `modules/agents` ← `modules/chat`. `shared/domain/exactContent.ts` imports nothing from `modules/*`.

## Persisted Shape

```
agents.greeting_settings (JSONB, unchanged): greetingInstruction, assistantDefaultLocale, proactiveGreetingEnabled — unchanged.

agent_drafts.snapshot / agent_revisions.snapshot (agentRevisionSnapshotSchema):
{
  ...existing keys,
  greeting?: {
    exactWordsEnabled: boolean,
    exactContent: {
      chips: string[],                           // 0–5 stable ids, authoritative order
      variants: Array<{
        locale: string,                          // normalized tag; must include agent default locale
        body: string,                            // 1–8000 code points, nonblank, no unknown {{…}}
        chipLabels: Record<string, string>       // chip id → 1–80 char label; keys == chips
      }>
    } | null
  }
}
```

No migration. Absent `greeting` = `{ exactWordsEnabled: false, exactContent: null }`.

## OpenAPI / SDK Deltas

| File | Change |
|---|---|
| `backend/src/app/http/openapi/schemas/agentSchemas.ts` | Agent draft/revision read schemas gain `greeting` (`exactWordsEnabled`, `exactContent`); draft write endpoint for greeting content. Existing greeting fields unchanged. |
| `backend/src/app/http/openapi/schemas/assistantHistorySchemas.ts` | `id: z.string().optional()` on `ChatSuggestionSchema`. |
| `backend/src/modules/chat/types/chatResponses.ts` | `id?: string` on `ChatSuggestion`. |
| `backend/openapi.yaml` / `.json` | Regenerated. |
| `typescript-sdk/openapi/*`, `typescript-sdk/src/generated/*` | `cd typescript-sdk && pnpm run sync`. |
| `packages/radioso-mcp-server` | OpenAPI copy sync + check. |

## Observability

`chat.bootstrap` audit event (`chatBootstrapService.ts:161-176`) gains `greetingMode`, `requestedLocale`, `resolvedLocale`, `fallbackApplied`; failure branch (`:214-228`) gains `reasonCode` (`missing_variant | unavailable_reference | oversized | conflict`). Never body text or labels. No new metric — audit events already carry conversation/workspace/revision correlation.

## Frontend

| Concern | File |
|---|---|
| Three-way choice, per-language variant editor, chip list (0–5) | `frontend/components/dashboard/settings/assistant-profile-section.tsx` (Switch block ~L380-410 → selector; reuse `assistant-locale-combobox.tsx` per variant); saves exact content to the draft with the existing publish affordance |
| Test Chat / candidate preview | `frontend/components/dashboard/agent-revision-test-chat.tsx` — resolved variant + fallback identification |
| Chip rendering on greeting | `frontend/components/chat/public-chat-shell.tsx` (~L450-525) — already reads `greetingMessage?.suggestions`; key by `suggestion.id` |
| Types | `frontend/lib/api-types.ts` derives from SDK; no manual edit |
| Playwright | `frontend/tests/e2e/greeting-exact-words.spec.ts` (mirrors `directives-settings.spec.ts`) |

## Test Plan (failing tests first)

| Layer | File |
|---|---|
| Shared resolver | `backend/tests/unit/exact-content.domain.test.ts` |
| Revision snapshot | `backend/tests/unit/agent-greeting-revision-snapshot.test.ts` |
| Bootstrap | extend `backend/tests/unit/chat-bootstrap-service.test.ts` — exact skips `reserveAnswer`/`chatGateway.answer`; fallback; failure |
| Contract | extend `backend/tests/contract/public-chat.contract.test.ts` — `suggestions[].id`; agent draft `greeting` |
| Ray | extend `backend/tests/unit/operatorCopilot/copilot-agents-tools.test.ts` |
| Frontend unit | `frontend/tests/unit/exact-greeting-variant-editor.test.ts` (state/validation only) |
| Frontend e2e | `frontend/tests/e2e/greeting-exact-words.spec.ts` |

## Work Packages

| # | Package | Files | Depends |
|---|---|---|---|
| 1 | Shared contract: types, validation, resolver, tests | `backend/src/shared/domain/exactContent.ts`, `backend/tests/unit/exact-content.domain.test.ts` | — |
| 2 | Revision snapshot + draft writer + agent service/route for greeting draft edits | `agentRevision.ts`, `agentDraftMutation.ts` (greeting writer), `agentService.ts`, `agentRevisionRoutes.ts` / `agentRevisionPresenters.ts`, `agentSchemas.ts`, tests | 1 |
| 3 | Bootstrap delivery: exact branch before reservation, resolve, `suggestions` + `id`, audit fields | `chatBootstrapService.ts`, `chatResponses.ts`, `assistantHistorySchemas.ts`, `chat-bootstrap-service.test.ts` | 1, 2 |
| 4 | Contract regen: OpenAPI, SDK sync, MCP sync, contract tests | generated files + `public-chat.contract.test.ts` | 2, 3 |
| 5 | Ray coverage: greeting draft proposal + coverage-map exclusion for `propose_agent` | `operatorCopilot/tools/*`, `copilotToolCatalog.ts`, tests | 2 |
| 6 | Frontend authoring + preview + chip rendering + docs | files in Frontend table + `docs/settings-docs/general/{greeting-instruction,proactive-greeting-enabled,assistant-default-locale}.md`, public-chat/SDK docs | 3, 4 |

All packages ≤ 8 files.

## Message-Queue Impact Review

None. Bootstrap is synchronous HTTP; exact content is never enqueued, emailed, or dispatched (F11).
