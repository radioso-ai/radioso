# Tasks: Retrieval Strategy Diagnostics

**Input**: Design documents from `/specs/060-retrieval-strategy-diagnostics/`
**Prerequisites**: plan.md, spec.md

**Tests**: Backend tests must be written before implementation.

## Phase 1: Setup

- [x] T001 Create Speckit spec, plan, and checklist for retrieval strategy diagnostics.
- [x] T002 Inspect retrieval trace, telemetry, OpenAPI, and history seams before implementation.

## Phase 2: Foundational

- [x] T003 [P] Add failing unit coverage for retrieval strategy selection.
- [x] T004 [P] Add failing unit coverage for retrieval skill diagnostic validation and telemetry metadata.

## Phase 3: User Story 1 - See The Retrieval Strategy Used (Priority: P1)

**Goal**: Retrieval answer responses expose strategy metadata through the existing trace graph.

**Independent Test**: `POST /api/v1/retrieval/answer` returns trace summary strategy fields and a `strategy_selection` stage.

- [x] T005 [P] [US1] Add failing contract coverage for retrieval answer trace strategy fields.
- [x] T006 [US1] Implement retrieval strategy selector and query-shape types.
- [x] T007 [US1] Add strategy selection to retrieval diagnostics and trace assembly.
- [x] T008 [US1] Add valid `SkillDiagnostic` mapping for `retrieval.answer`.

## Phase 4: User Story 2 - Preserve Strategy Diagnostics In History (Priority: P2)

**Goal**: Existing audit-backed history/debug replay preserves additive strategy diagnostics.

**Independent Test**: Chat history debug payload includes the stored retrieval trace strategy fields.

- [x] T009 [P] [US2] Add failing integration or unit coverage for history replay of strategy diagnostics.
- [x] T010 [US2] Verify existing chat/search audit metadata paths preserve the additive trace shape.

## Phase 5: User Story 3 - Audit Retrieval Strategy Through Telemetry (Priority: P3)

**Goal**: Retrieval telemetry can be grouped by skill, strategy, query shape, surface, and fallback.

**Independent Test**: Telemetry unit coverage observes expected tags and metadata without raw content.

- [x] T011 [P] [US3] Add failing telemetry unit coverage.
- [x] T012 [US3] Extend retrieval pipeline telemetry event metadata and tags.

## Phase 6: Contracts, Docs, And Generated Artifacts

- [x] T013 Update code-first OpenAPI schemas and regenerate backend OpenAPI artifacts.
- [x] T014 Sync TypeScript SDK generated types and verify SDK build.
- [x] T015 Update docs to describe activity/debug graph retrieval strategy diagnostics.
- [x] T016 Run backend unit, contract, integration, build, and SDK validations.

## Dependencies & Execution Order

- T003-T005 and T009-T011 are test-first tasks and should precede implementation.
- T006-T008 complete the response trace MVP.
- T010 confirms persistence through existing audit metadata; no schema changes are expected.
- T013-T015 must follow implementation because they reflect final additive contracts.
