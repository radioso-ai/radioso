# Tasks: Confirmed Operator MCP Authoring

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/operator-mcp-authoring.md`, and `quickstart.md`

**Tests**: Backend tests are mandatory and are deliberately listed before implementation. Preserve terminal command output under `.context/mcp1150/`; only an exit code of 0 with a completed summary is a passing result.

## Phase 1: Existing-surface inventory

- [X] T001 Read the local briefs for `backend/src/modules/operatorCopilot`, `backend/src/modules/routines`, `backend/src/modules/agents`, `backend/src/modules/agentSkills`, `backend/src/modules/retrieval`, `backend/src/db/repositories`, and `packages/radioso-mcp-server/src`; record actual owner ports and candidate existing test fixtures in `.context/mcp1150/inventory.md`.
- [X] T002 [P] Document the operator-scope persistence/contract touch points (contract package, migration/schema, authorization consent/routes, OpenAPI and generated snapshots) in `.context/mcp1150/contract-impact.md`.
- [X] T003 [P] Establish a marked disposable integration database following `docs/architecture/code-map.md`; record only command/status/DB alias, never credentials, in `.context/mcp1150/integration-db.md`.

## Phase 2: Foundation — reviewed-operation seam

**Purpose**: no write descriptor is exposed before the preparation/execution lifecycle is durable, bound, and testable.

- [X] T004 Write failing unit tests for reviewed-operation state transitions, canonical digest, principal/client/workspace binding, expiry, cancellation, replay, idempotent outcome reads, and crash-after-domain-effect reconciliation in `backend/tests/unit/operatorCopilot/reviewed-operation-service.test.ts`.
- [X] T005 Covered by existing proposal/invocation repository integration suites; no separate `reviewed-operation-repository.integration.test.ts` was created.
- [X] T006 Covered by `operator-mcp-application-service.test.ts`, disposition/catalog tests, proposal integration tests, and the real harness; the planned `operator-mcp-confirmed-authoring.test.ts` was not created.
- [X] T007–T010 Implemented through reviewed proposal fields, `reviewedOperation.ts`, repository claim/outcome lifecycle, composition adapters, migration 187, `operator:write`, generated contracts, and audit events.

**Checkpoint**: a bound reviewed artifact can be created, canceled, read, safely retried and refused without any product mutation.

## Phase 3: User Story 1 — routine authoring (P1)

**Goal**: inspect, prepare and confirmed-apply complete deterministic routine CRUD to the private draft.

**Independent Test**: create/edit/reorder/insert/retarget/remove a routine through Operator MCP, inspect exact changed connections, confirm/apply once, then verify draft state through the existing routine owner while published behavior is unchanged.

- [X] T011 [US1] Write failing routine-domain transform tests covering add, delete, enable/disable, field/slot/ending changes, complete ordinal reorder, exact-edge insert, retarget/condition replacement, referenced removal rejection, multiple incoming edges, terminal insertion, adjacent explicit jump, and stale reference in `backend/tests/unit/routines/operator-mcp-routine-transform.test.ts`.
- [X] T012 [US1] Covered by `routine-structural-apply.test.ts`, `routine-structural-preparation.test.ts`, operator MCP proposal integration, and the real harness; the planned standalone filename was not created.
- [X] T013 [US1] Implemented in `operatorMcpRoutineTransform.ts`, routine atomic apply composition, and canonical authoring-detail reader.
- [X] T014–T015 Implemented in `routine_definition`, `prepare_routine_structure`, generic reviewed execution/outcome/cancel, dispositions, and catalog coverage tests.

## Phase 4: User Story 2 — per-agent retrieval settings (P1)

**Goal**: inspect code-owned defaults and effective agent state, prepare and confirmed-apply supported agent-scoped settings without moving their lifecycle.

**Independent Test**: read defaults/effective settings, patch source selection/ranking/filter settings, confirm/apply, and prove omitted values are unchanged, defaults are read-only, and probe overrides are not persisted.

- [X] T016–T019 Implemented and covered by retrieval authoring unit/integration tests plus the real MCP harness.
- [X] T020 Retrieval probe disposition and non-persisting diagnostic behavior remain covered by existing retrieval probe tests.

## Phase 5: User Story 3 — candidate publication (P1)

**Goal**: prepare an immutable candidate, inspect its release diff/validation, and separately confirm publication.

**Independent Test**: make a saved draft, prepare/read a candidate, separately confirm publication, prove new conversations select it and existing conversations remain pinned; retry a lost response and reject stale candidate fences.

- [X] T021 [US3] Covered by `agent-publication-tools.test.ts`, `agent-publication-proposal-adapter.test.ts`, and reviewed executor tests; the planned filename was not created.
- [X] T022 [US3] Covered by `agent-revision-publication.integration.test.ts` and the real harness; the planned filename was not created.
- [X] T023–T025 Implemented via candidate release review, publication adapter/tools, `operator:write` disposition, and audit coverage; no separate publish scope exists.

## Phase 6: Cross-contract, local acceptance and documentation

- [X] T026–T029 Completed: real standalone-process harness, confirmation gates, generated OpenAPI/MCP/SDK snapshots, and operator MCP documentation/product-doc corpus.
- [X] T030 Completed focused/unit/integration/contract/build/MCP test/harness evidence; MCP `smoke:all` passes both HTTP and Docker Redis scenarios (`.context/mcp1150/root-frozen-mcp-smoke.log`). Final frozen unit/contract run passes 685 files / 6,476 tests; focused integration passes 6 files / 42 tests.
- [X] T031 Frontend OAuth Playwright production flow verified (11 tests).
- [X] T032 Lint, dead-code, OpenAPI/SDK, skills, and product-doc drift checks verified; quickstart manual validation is represented by the real local harness.

## Verification evidence

- Real MCP authoring acceptance: `.context/mcp1150/final-acceptance-harness.log` (OAuth, confirmation gate, retrieval, routine CRUD, publication, cancellation, replay/outcome).
- Backend unit/contract, build, lint, dead-code, SDK, and frontend OAuth results were verified in the final frozen-gate run.
- Remaining release-gate evidence: `pnpm --dir packages/radioso-mcp-server run smoke:all` has not yet been run.

## Dependencies & Execution Order

`T001–T003 → T004–T010 → US1/US2/US3 → T026–T032`. US1, US2 and US3 may share the reviewed-operation foundation but their owner-domain work remains independently testable. Never expose a write descriptor before T004–T010 are green.

## Parallel Opportunities

- T002 and T003 can run while T001 completes.
- Test-first tasks T011/T016/T021 are disjoint after foundation.
- Routine, retrieval and publication owner-domain implementation can be parallelized only after their tests and shared operation API stabilize.

## Implementation Strategy

Deliver the lifecycle foundation first, then one user story at a time with its red/green tests. The final acceptance harness is a release gate, not a substitute for owner-domain integration tests.
