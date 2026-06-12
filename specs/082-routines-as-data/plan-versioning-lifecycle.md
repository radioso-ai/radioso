# Implementation Plan: 082 Amendment Versioning & Lifecycle

**Branch**: `sofia` | **Spec**: `specs/082-routines-as-data/amendment-versioning-lifecycle.md`
**Scope**: amendment §7 slices 1–6 (lineage model, pinned-version runtime resolution, scoped-directive re-pointing, HTTP/OpenAPI contract, dashboard, docs).

## Summary

Routine definitions gain an explicit lineage (`lineage_id`) and a full lifecycle: `draft → published → superseded | archived`, with revise (edit-published → draft copy), supersede-on-publish (exactly one published version per lineage; draft consumed), archive/restore, pinned-version resume for in-flight conversations, and automatic scope-tag re-pointing for routine/step-scoped directives. The dashboard list collapses to one row per lineage with a version-history panel in details.

## Technical Context

- Latest migrations on branch: two `089_*.sql` files exist (`089_routine_default_guard_schema_cut.sql`, `089_workspace_webhook_destinations.sql`); the new migration is `090_routine_lineage_lifecycle.sql`.
- Schema owner: `backend/src/db/migrations/084_routine_definitions.sql` defines `routine_definition` (PK `id`, `UNIQUE(agent_id, name, version)`, `CHECK (status IN ('draft','published'))`).
- Persistence owner: `backend/src/db/repositories/routineDefinitionRepository.ts` — `publish()` (already snapshots a new row keyed by `(agent_id, name)`; must become lineage-keyed + supersede + consume draft), `deleteDraft()`, `listByAgent()`, `listPublishedByAgent()`, `findById()`, `replaceChildren()`.
- Domain/service owner: `backend/src/modules/routines/service.ts` (`RoutineDefinitionService`), domain types in `backend/src/modules/routines/domain.ts` (`status` enum lives here and flows into Zod/OpenAPI).
- Directive scope tags: `agent_directives.scope_tags TEXT[]` (migration `082_agent_directive_scope_tags.sql`), conventions `routine:<definitionId>` and `step:<definitionId>:<stepId>` (see `packages/conversation-contract/index.d.ts` Directive docs). Persistence owned by the agent/directive repository — the routines service consumes a narrow re-pointing port, it does not write `agent_directives` SQL itself.
- Runtime seam: `backend/src/app/server/dependencyBuilders.ts:894-960` builds `ChatRoutineProvider.forTurn` from `createPublishedRoutineRegistrationSource` (`backend/src/app/composition/routineDefinitionSource.ts`). The engine resumes by `this.routines.find(c => c.id === state.routineId)` (`packages/conversation-engine/src/routineRunner.ts:151`); routine state is stored in `routine_states` (`071_routine_states.sql`, `routine_id` TEXT, no FK). Pinned resolution therefore lives in composition: the provider must load the session's pinned definition (any status) as a **resume-only** routine — available to the runner, never an activation candidate. Engine packages remain untouched (parent SC-006).
- HTTP owner: `backend/src/app/http/routes/agentRoutes.ts` (routines block ~lines 259–380). OpenAPI registry: `backend/src/app/http/openapi/schemas/agentSchemas.ts` + `backend/src/app/http/openapi/paths/agentsPaths.ts`; generated artifacts `backend/openapi.yaml`, `backend/openapi.json`, `typescript-sdk/openapi/radioso.{yaml,json}`, `typescript-sdk/src/generated/types.ts`, `packages/radioso-mcp-server/src/generated/openapiTypes.ts`.
- Frontend owners: `frontend/lib/api-types.ts` (RoutineDefinition type), `frontend/lib/api-routines.ts` (API adapter), `frontend/components/dashboard/settings/assistant-routines-section.tsx` (list + editor), e2e `frontend/tests/e2e/routines-settings.spec.ts`.
- Docs owner: `docs/authoring-routines.md` (read `docs/document-writer-prompt.md` first).
- Tests: backend Vitest under `backend/tests/unit/` (`routine-definition-service.test.ts`, repository fakes) and integration under `backend/tests/integration/`; frontend unit `frontend/tests/unit/routines-api.test.ts`; Playwright `routines-settings.spec.ts`.

## Constitution Check

- **Spec-first**: approved amendment exists (requestor sign-off 2026-06-12); this plan implements it only.
- **Backend TDD**: every backend slice writes failing tests first — repository lifecycle tests, service transition tests, pinned-resume integration test, re-pointing tests.
- **Stack discipline**: TypeScript/Express/Postgres only; no new dependency.
- **No keyword lists**: lifecycle is typed status enums and structural ids; no prose interpretation anywhere.
- **Modularity**: lifecycle rules in `modules/routines/service.ts`; atomicity in the repository; scope-tag SQL stays in the directives-owning repository behind a port; pinned-resume wiring in composition (`routineDefinitionSource.ts` / `dependencyBuilders.ts`), not in engine packages; routes stay validation+shaping.
- **Composition**: `routineDefinitionSource.ts` gains the pinned-resume load path — this is replaceable runtime wiring and correctly lives in `backend/src/app/composition/`.
- **Contracts & queues**: routines REST contract changes (new endpoints + new fields + status enum) → code-first OpenAPI registry update, regenerate backend/SDK/MCP artifacts, align contract tests. **Message-queue impact review**: routine completion exports dispatch via the action outbox keyed on definition id; versioning adds rows but changes no payload shape, retry semantics, or queue docs — verify by search over worker payload builders and record evidence in `slice-vl-notes.md`. Expected outcome: no queue changes.
- **Docs parity**: `docs/authoring-routines.md` lifecycle section + any API docs enumerating routine statuses, same change.
- **Observability**: lifecycle transitions are new operator-relevant runtime paths → audit events for publish/supersede, revise, archive, restore (workspace/agent/routine/lineage/version correlation, no document content); keep the existing compile-failure warn path; add a warn log when a pinned definition fails to load for resume. No new metrics.

## Module Design

### What each file knows

- `090_routine_lineage_lifecycle.sql`: schema only — `lineage_id UUID`, backfill `(agent_id, name)` groups, `NOT NULL`, status CHECK extended to `('draft','published','superseded','archived')`, partial unique index `one draft per lineage`, partial unique index `one published per lineage`, index on `(agent_id, lineage_id)`. Knows nothing about transitions.
- `routineDefinitionRepository.ts`: owns atomic transitions — lineage-keyed `MAX(version)+1` (advisory lock keyed by lineage, replacing the name-keyed lock), publish = insert published + mark prior published `superseded` + delete draft, `createRevisionDraft(agentId, publishedId)` (copy row + children + completion export, preserve stable ids verbatim, same lineage), `archive`/`restore` status updates with guard conditions in SQL (`WHERE status = ...`), `findByIdAnyStatus` for pinned resume. Returns booleans/rows; no business errors.
- `modules/routines/service.ts`: owns lifecycle legality (revise resolves to existing draft; restore only when lineage has no published version; archive only on published), orchestrates publish → re-point port → audit; maps repository outcomes to 4xx domain errors.
- Directives port (new, defined by routines service, implemented by the directives-owning repository): `repointRoutineScopeTags({agentId, fromDefinitionId, toDefinitionId, survivingStepIds}) → { repointed, orphans }`. Routines module knows tag *conventions*; directives repository knows tag *storage*.
- `routineDefinitionSource.ts`: knows how to turn definitions into registrations; gains `loadPinned({agentId, routineIds})` returning resume-only registrations (compiled, no trigger eligibility).
- `dependencyBuilders.ts` routine provider: knows how to union activation candidates (published) with resume-only pinned routines for the session; passes resume-only set so the activator never sees them. (`RoutineRegistry` in `modules/chat` gains a resume-only input; engine `DefaultRoutineRunner` already takes a flat routines list — unchanged.)
- `agentRoutes.ts`: new thin handlers `POST .../routines/:routineId/revise|archive|restore`; publish response gains `directiveScopeOrphans`.
- `assistant-routines-section.tsx`: renders lineage rows (grouping via lineage fields from the API), version history panel, revise/archive/restore actions. Grouping logic lives in a pure helper (`frontend/lib/routine-lineage.ts`) unit-testable without markup assertions.

### Contract decisions (resolving amendment §8 open questions)

- **List contract shape**: keep `GET /agents/:agentId/routines` flat; every routine gains `lineageId` (and `supersededAt`-style data stays derivable from status + timestamps). The dashboard groups client-side in `frontend/lib/routine-lineage.ts`. No server-grouped resource in v1 — smallest contract delta, UI never guesses identity (FR-031 satisfied via `lineageId`).
- **Pinned-source seam**: composition (`routineDefinitionSource` + provider), per above; `forTurn` gains the session/conversation id already available to ChatService.
- **Re-pointing transactionality**: re-point runs **inside the publish transaction** via the port (repository method accepts the client/transaction handle per existing repo patterns, or the service wraps both repos in one `withTransaction`); publish response carries orphans. Simplest consistent story: publish either fully lands (supersede + re-point) or not at all.
- **Backfill safety**: migration backfills one lineage per `(agent_id, name)` group; a pre-check in the migration asserts no group has two `published` rows (raises if violated, with remediation note). Existing data created via UI cannot violate it (publish has always superseded-by-accident… it has not — two published rows per name ARE possible today via republish; the backfill treats the **newest published row per group as published** and marks older published rows `superseded` as part of the migration, which also retro-fixes the double-activation bug).

## Validation Plan

- Repository: `cd backend && pnpm vitest run tests/unit/routine-definition-repository*.test.ts tests/unit/routine-definition-service.test.ts`
- Lifecycle integration (supersede mid-conversation → pinned resume; archive/restore): `cd backend && pnpm run test:integration -- routine` (new `backend/tests/integration/routine-lifecycle.integration.test.ts`)
- Contract: regenerate OpenAPI/SDK/MCP artifacts via repo scripts; `pnpm run test:contract` in backend.
- Frontend: `cd frontend && pnpm vitest run tests/unit/routine-lineage.test.ts tests/unit/routines-api.test.ts`; Playwright `routines-settings.spec.ts` (revise→publish journey, archive/restore, lineage-grouped list).
- Full gate before PR: `pnpm run ci:local -- origin/main` (note: `websiteCrawler` routes test has a known order-dependent flake — re-run before attributing).
