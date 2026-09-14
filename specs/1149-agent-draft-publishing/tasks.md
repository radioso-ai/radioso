# Tasks: Agent Draft Publishing

**Feature**: `1149-agent-draft-publishing`  
**Tests**: Required for every backend task (constitution TDD); frontend behavior uses Playwright.

## Dependencies

`Setup → Foundation → US1 → US2 → US3 → US4 → Cockpit/docs`. US2 and US3 may proceed after the revision resolver seam is complete; US4 requires runtime/eval bindings.

## Phase 1: Setup and discovery

- [X] T001 Inventory every scoped writer and runtime reader, with owner and cutover risk, in `specs/1149-agent-draft-publishing/plan.md`
- [X] T002 Read and update local ownership briefs before edits: `backend/src/modules/agents/README.md`, `backend/src/modules/chat/README.md`, `backend/src/modules/directives/README.md`, `backend/src/modules/agentBundle/README.md`
- [X] T003 Define the versioned HTTP/SDK/MCP/Ray compatibility migration and queue-impact decision in `specs/1149-agent-draft-publishing/plan.md`

## Phase 2: Foundational revision boundary

- [X] T004 [P] Write failing domain tests for draft generation, immutable candidate content, concurrency, idempotency, and publication invariants in `backend/tests/unit/agent-revision-service.test.ts`
- [X] T005 [P] Write failing repository/migration tests for revisions, publication pointers, bindings, and backfill classification in `backend/tests/integration/agent-revision-backfill.integration.test.ts`
- [X] T006 Add agent revision domain types and narrow repository/projection/resolver ports in `backend/src/modules/agents/agentRevision.ts` and `backend/src/modules/agents/public.ts`
- [X] T007 Add PostgreSQL migrations, generated schema types, row mappers, and repository adapter in `backend/src/db/migrations/` and `backend/src/db/repositories/agentRevisionRepository.ts`
- [X] T008 Implement draft/candidate/publication service and content-safe audit correlation in `backend/src/modules/agents/agentRevision.ts`
- [X] T009 Add directive, routine, and context-variable projection/validation ports without importing their repositories into agents in `backend/src/modules/directives/public.ts`, `backend/src/modules/routines/public.ts`, and `backend/src/modules/context-variables/public.ts`
- [X] T010 Wire default revision repositories/projection adapters in `backend/src/app/composition/` and add composition coverage in `backend/tests/unit/routine-definition-composition.test.ts` and `backend/tests/integration/test-execution-routes.integration.test.ts`

## Phase 3: User Story 1 - private draft and explicit publish

- [X] T011 [US1] Write failing HTTP/contract tests for draft writes, candidate creation, explicit publish, stale tokens, idempotency, authorization, and no direct-live fallback in `backend/tests/contract/agents.contract.test.ts`
- [X] T012 [US1] Route agent/directive/routine/context writer services through authorized draft commands in `backend/src/modules/agents/services/`, `backend/src/modules/routines/service.ts`, and `backend/src/modules/context-variables/services/contextVariableService.ts`
- [X] T012a [US1] Route directive create/update/delete and typed draft projection through one locked repository transaction; prove rollback, concurrent ordering, candidate visibility, and successful-only generation changes in `backend/tests/integration/agent-directive-draft-atomic.integration.test.ts`
- [X] T012b [US1] Route custom-instruction and context-enablement writes, including Copilot proposal application, through the same locked repository mutation; prove reload, candidate isolation, rollback, stale/no-op, and concurrent ordering in focused Postgres integration suites
- [X] T012c [US1] Route routine create/update/local-publish/revise/archive/restore/delete through the same locked transaction; project the selected definition per lineage, atomically repoint directive scope tags, and reject incomplete routine closures at candidate/release time
- [X] T013 [US1] Add code-first draft/candidate/publish schemas, routes, presenters, and OpenAPI registration in `backend/src/app/http/`
- [X] T014 [US1] Regenerate API outputs and synchronize the TypeScript SDK in `backend/openapi.yaml`, `backend/openapi.json`, and `typescript-sdk/`
- [X] T015 [US1] Route Ray/operator-copilot, MCP, import/restore, and SDK writer surfaces through the same draft/publication ports in `backend/src/modules/operatorCopilot/`, `packages/radioso-mcp-server/`, `backend/src/modules/agentBundle/`, and `typescript-sdk/`

## Phase 4: User Story 2 - pinned test and production runtime

- [X] T016 [US2] Write failing tests for first-turn revision binding, resumed conversation/routine closure, unavailable revision failure, and no mutable-authoring lookup in `backend/tests/unit/agent-revision-runtime-resolver.test.ts` and `backend/tests/unit/chat-service-streaming.test.ts`
- [X] T017 [US2] Implement revision-aware configuration resolution and bind conversations before first turn in `backend/src/modules/chat/services/` and `backend/src/shared/agent-runtime/`
- [X] T018 [US2] Preserve revision identity through routine state, worker handoffs, and safe-test dispatch in `backend/src/modules/routines/` and `backend/src/modules/chat/services/`
- [X] T019 [US2] Add test-candidate selection, sample-value validation, operator-only authorization, comparison execution identities, cancellation fencing, and failed-side retry in `backend/src/modules/test-execution/testExecution.ts`
- [X] T020 [US2] Add focused integration tests for draft test isolation and production pinning in `backend/tests/integration/test-execution-routes.integration.test.ts` and `backend/tests/integration/agent-revision-backfill.integration.test.ts`

## Phase 5: User Story 3 - revision-aware eval evidence

- [X] T021 [US3] Write failing tests for frozen revision/case/input/policy provenance, retry identity, partial comparison results, and no eval publish gate in `backend/tests/unit/revision-eval-run-service.test.ts`
- [X] T022 [US3] Persist eval revision provenance and freshness state in `backend/src/modules/eval/services/` and `backend/src/db/repositories/`
- [X] T023 [US3] Carry immutable execution identity through eval dispatch/retry and record the queue payload/retry review in `backend/src/modules/eval/` and `specs/1149-agent-draft-publishing/plan.md`
- [X] T024 [US3] Expose candidate-aware eval selection/results contracts and contract tests in `backend/src/modules/eval/routes/` and `backend/tests/contract/`

## Phase 6: User Story 4 - migration, first publish, and channels

- [X] T025 [US4] Write failing migration tests for equivalent existing-agent backfill, dirty authoring preservation, legacy classification, and retained active routine definitions in `backend/tests/integration/agent-revision-backfill.integration.test.ts`
- [X] T026 [US4] Implement backfill, classification, deployment barrier, and old-worker drain/cutover protections in `backend/src/db/migrations/171_agent_draft_revisions.sql`, `backend/src/modules/agents/`, `backend/src/modules/routines/draftProjection.ts`, and runtime composition
- [X] T027 [US4] Write failing tests for unpublished created/imported agents and explicit public not-published responses in `backend/tests/contract/agents.contract.test.ts`
- [X] T028 [US4] Implement first-publication state in agent creation/import and public channel resolution in `backend/src/modules/agents/`, `backend/src/modules/agentBundle/`, and channel runtime surfaces
- [X] T029 [US4] Verify every supported channel starts at current published revision while ongoing sessions remain pinned in `backend/tests/integration/`

## Phase 7: Cockpit, documentation, and cross-cutting validation

- [X] T030 [P] Implement persistent agent cockpit/header, routed horizontal tabs, separate Manage Channels, and revision-status API adapter in `frontend/`
- [X] T031 [P] Implement Test Chat single/compare/Test Values/eval evidence states and stream fencing in `frontend/`
- [X] T032 Add Playwright journeys for edit-save-test-compare-eval-publish, deep links, unsaved edits, stale streams, partial results, and first publish in `frontend/tests/e2e/agent-cockpit.spec.ts`
- [X] T033 Update operator, API, SDK, MCP, and migration documentation after reading `docs/document-writer-prompt.md` in `docs/` and `docs-portal/content/`
- [X] T034 Run focused backend tests, `pnpm run lint`, `pnpm run lint:dead-code:ci`, backend build/contract/integration checks, SDK build/tests, frontend build/Playwright, and deterministic eval suites; record evidence in this file

## Parallel Opportunities

- T004/T005 can proceed in parallel after writer/reader inventory.
- T009 projection ports can proceed in parallel with T007 persistence design.
- T030/T031 may proceed after the reviewed backend contract is stable; frontend implementation must not invent backend semantics.

## Implementation Strategy

Deliver the revision aggregate and publish safety invariant first, then bind runtime reads, then provenance-aware evals and migration. Do not ship a cockpit that implies private behavior until every scoped writer and runtime reader is on the revision boundary.

## Verification — 2026-09-08

- Full backend unit suite: 597 files, 5,804 tests passed with two workers. This includes the deterministic conversation-quality and Copilot eval suites.
- Final PostgreSQL integration selection: 13 files, 80 tests passed, covering atomic authoring, publication, cutover, private executions, eval persistence, import, and session mapping. Cutover regressions use their own temporary database.
- Backend contract suite: 430 of 432 tests passed in the combined run; two tests hit the 10-second timeout under concurrent machine load. The entire affected agents contract file then passed in isolation (31 tests), including both timed-out cases.
- Cockpit browser suite: 20 journeys passed, including draft save, publication, independent comparison histories, stream fencing, eval retry, mobile deep links, and interleaved live/private saves. These journeys use mocked HTTP transports; PostgreSQL service/HTTP integration checks provide separate backend evidence.
- Backend, frontend, and docs portal production builds passed. SDK build and all 27 SDK tests passed. Database type-generation checks passed. Fable's follow-up design review passed with no blocking findings.
- Root lint and the dead-code ratchet passed. The ratchet contains 1,289 existing findings outside touched code and no new findings; 40 obsolete baseline entries were removed.
- The final eval-retry browser regressions passed (2 tests): execution failures can retry; completed quality failures retain their evidence without offering an unsupported retry. Targeted lint passed after this correction.
- Generated SDK OpenAPI JSON and YAML match the backend outputs byte for byte. Database schema and Kysely types were regenerated from repository-owned temporary containers.

Live provider evals and deployment were not run. The migration requires draining old application replicas and worker consumers before starting revision-aware code; see the operator deployment guide. Missing, ambiguous, or invalid legacy routine pins remain unbound and are listed in the migration-classification table for operator resolution.


## Approved cockpit usability follow-up

- [X] T035 Restore sidebar agent list, selected identity, New agent flows, nested Channels, and real channel overview; simplify the cockpit header and keep channel pages outside publication controls.
- [X] T036 Add stable per-agent publication numbers with deterministic backfill, concurrency/idempotency tests, transport summaries, and synchronized SDK artifacts.
- [X] T037 Add authorized private execution list/detail contracts and durable single/comparison history reopening; preserve access to legacy private test sessions.
- [X] T038 Replace Start test with lazy first-send and New chat; integrate actual asynchronous Save draft & send and preserve retry/stream/eval fences.
- [X] T039 Verify the combined visible journeys, relevant backend persistence/contracts, lint/dead-code, builds, and documentation; refresh the managed local preview with preserved data.

### Cockpit follow-up validation — 2026-09-08

- All 39 selected production-browser journeys passed across the final broad run (38 passed) and the corrected header-save check (1 passed). The header check now asserts the completed save state: the Save draft action disappears. These journeys use mocked HTTP transports and cover sidebar/channel navigation, creation access, legacy/new history, exact failed-turn retry, single/comparison follow-ups, save failure and stale async fences, and desktop/mobile layouts.
- Focused PostgreSQL publication/history/HTTP tests passed, including sequential numbering, idempotent replay after a newer publication, scoped history pagination, and exact stored attempt details. Backend production build, schema/type generation checks, SDK build and 27 SDK tests passed. OpenAPI JSON/YAML match the SDK snapshots byte for byte.
- Frontend unit suite passed during implementation (171 files / 1,433 tests); the final stream-completion and API state changes passed their focused two-file suite (12 tests). Frontend typecheck and production build passed. Docs portal build passed, and the workbench guide uses an updated populated comparison screenshot.
- Root lint and dead-code gates passed. Removed unused exports and one touched baseline finding; 1,288 existing findings remain outside touched code.
- Follow-up Fable review was attempted but did not run because Claude returned a session-limit error. No new Fable PASS is claimed. Root visually inspected the desktop/mobile captures.

- Final Copilot coverage gate passed (22 tests) with explicit private-history exclusions. Targeted closeout lint passed. Managed preview frontend, backend, document worker, and crawler worker are running; real sign-in, History, Channels overview, and same-origin health were verified. Migration 178 applied against preserved data after a protected backup.

## Chat presentation refinement

- [X] T040 Remove cockpit tabs from Channels; align draft status and publication actions with page title.
- [X] T041 Restore shared chat thread and composer presentation; move History, comparison, evals and optional Test context to the title overflow menu.
- [X] T042 Verify existing immutable execution journeys and desktop/mobile presentation; refresh guide and preview.

Closeout evidence: final production-browser run passed all 41 journeys (`.context/chat-simplification-playwright-final.log`); focused mobile verification passed all 6 journeys (`.context/chat-simplification-mobile-verified.log`). Latest desktop capture is refreshed at `docs-portal/public/screenshots/dashboard-agents-workbench.png`.
