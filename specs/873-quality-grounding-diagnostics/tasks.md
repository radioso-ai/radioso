# Tasks: Quality Grounding Diagnostics

**Input**: Design documents in `specs/873-quality-grounding-diagnostics/`
**Prerequisites**: approved spec, plan, research, data model, contract, quickstart

## Phase 1: Setup

- [X] T001 Verify approved checklist, branch, repository ignore files, and focused test commands in `specs/873-quality-grounding-diagnostics/quickstart.md`
- [X] T002 Record code-first OpenAPI, SDK/MCP sync, message-queue no-impact, and observability no-change decisions in `specs/873-quality-grounding-diagnostics/plan.md`

## Phase 2: Foundational persistence boundary

- [X] T003 Write failing chat persistence tests for complete and absent grounding snapshots in `backend/tests/unit/chat-turn-lifecycle.test.ts` and the existing assistant-turn persistence integration test
- [X] T004 Define the neutral snapshot in `backend/src/shared/domain/groundingDiagnostic.ts`, project it in `backend/src/modules/chat/services/groundingDiagnostic.ts`, and add it to `backend/src/db/repositories/messageRepository.ts`
- [X] T005 Thread the computed snapshot through `backend/src/modules/chat/services/chatTurnLifecycle.ts` without moving grounding computation into persistence
- [X] T006 Persist/map the five scalars atomically in `backend/src/modules/chat/infra/postgresAssistantTurnPersistence.ts` and `backend/src/db/repositories/messageRepository.ts`

## Phase 3: User Story 1 — Understand why an answer needs review (P1)

**Independent Test**: Quality rows distinguish sourced, unsourced, invalid-source,
no-support, and unavailable diagnostics without opening the conversation.

- [X] T007 [US1] Write failing Quality response mapping tests in `backend/tests/integration/quality-turns.integration.test.ts`
- [X] T008 [US1] Add the complete-or-null Quality value and mapping seam in `backend/src/modules/quality/groundingDiagnostic.ts` and `backend/src/modules/quality/contracts/index.ts`
- [X] T009 [US1] Project and map grounding scalars in `backend/src/modules/quality/service.ts`
- [X] T010 [US1] Write failing visible evidence scenarios in `frontend/tests/e2e/quality-health.spec.ts`
- [X] T011 [US1] Extend frontend Quality types and render the compact Outcome/Action evidence breakdown in `frontend/lib/api-quality.ts` and `frontend/components/dashboard/quality-view.tsx`

## Phase 4: User Story 2 — Isolate a grounding failure (P1)

**Independent Test**: Evidence filters combine with existing filters, survive a
reload, appear as removable pills, and are cleared by signal presets.

- [X] T012 [US2] Write failing backend filter composition/total tests in `backend/tests/integration/quality-turns.integration.test.ts`
- [X] T013 [US2] Add focused scalar grounding predicates in `backend/src/modules/quality/groundingDiagnostic.ts` and compose them in `backend/src/modules/quality/service.ts`
- [X] T014 [US2] Write failing URL and API encoding tests in `frontend/tests/unit/dashboard-routes.test.ts` and `frontend/tests/unit/api-quality.test.ts`
- [X] T015 [US2] Add normalized evidence route state and API encoding in `frontend/lib/dashboard-routes.ts` and `frontend/lib/api-quality.ts`
- [X] T016 [US2] Extend Playwright coverage for Evidence filters, reload, pills, combinations, empty state, and signal reset in `frontend/tests/e2e/quality-health.spec.ts`
- [X] T017 [US2] Add the Evidence filter section and applied-filter wiring in `frontend/components/dashboard/quality-view.tsx`

## Phase 5: User Story 3 — Query diagnostics through the API (P1)

**Independent Test**: The endpoint returns complete/null diagnostics, accepts CSV
or repeated verdicts and strict booleans, and rejects invalid values.

- [X] T018 [US3] Write failing route parsing/error tests in `backend/tests/unit/quality-routes.test.ts`
- [X] T019 [US3] Add verdict and strict boolean transport schemas in `backend/src/modules/quality/routes.ts`
- [X] T020 [US3] Define grounding response/query schemas in `backend/src/app/http/openapi/schemas/qualitySchemas.ts` and `backend/src/app/http/openapi/paths/qualityPaths.ts`
- [X] T021 [US3] Regenerate backend, SDK, and MCP contract artifacts from `backend/openapi.json`
- [X] T022 [US3] Run focused contract tests and `pnpm run check:api-contracts`

## Phase 6: User Story 4 — Retain safe historical evidence (P2)

**Independent Test**: Only a complete, valid newest eligible lifecycle event
backfills a wholly null assistant message; retry does not overwrite.

- [X] T023 [US4] Write the failing isolated migration suite covering both event types, cross-type precedence, ID tie-break, malformed/partial/inconsistent data, no fallback, and retry safety in `backend/tests/integration/message-grounding-diagnostics-migration.integration.test.ts`
- [X] T024 [US4] Add constrained scalar columns and guarded backfill in `backend/src/db/migrations/132_message_grounding_diagnostics.sql`
- [X] T025 [US4] Refresh `backend/src/db/schema.sql` and `backend/src/shared/infra/kysely/schema.ts`

## Phase 7: Polish and cross-cutting validation

- [X] T026 Update the Quality module brief and operator/API guidance in `backend/src/modules/quality/README.md` and `docs/human-takeover.md`
- [X] T027 Verify stats/signal behavior and no queue/composition/observability changes with focused backend suites
- [X] T028 Run backend/frontend builds, frontend lint, SDK/MCP builds, and focused Playwright
- [X] T029 Run `pnpm run ci:local -- --all` to validate every local CI bucket, including real PostgreSQL migrations and integration tests
- [X] T030 Request senior-engineer review, resolve findings, rerun affected checks, and update `specs/873-quality-grounding-diagnostics/tasks.md`
- [X] T031 Complete engineering-manager scope/release review and apply in-scope feedback

## Dependencies

- T001–T002 gate planning.
- T003–T006 establish the write model used by every story.
- US1 mapping (T007–T011) precedes UI filtering.
- US2 backend/frontend filter work (T012–T017) and US3 transport/contract work
  (T018–T022) share the same typed contract and proceed after US1.
- US4 migration (T023–T025) depends only on the foundational column design but
  lands after runtime behavior is pinned.
- T026–T031 require all story phases.

## Parallel opportunities

- After T006, backend mapping tests and frontend Playwright fixtures can be
  authored independently.
- US2 URL/API encoding tests are disjoint from backend predicate tests.
- Contract generation and documentation begin after the runtime contract is
  stable.

## Implementation strategy

Deliver the narrow persistence snapshot first, then the read/display value, then
filters and public contracts, then historical recovery. This order makes every
slice independently testable and keeps migration behavior from becoming the
runtime implementation.
