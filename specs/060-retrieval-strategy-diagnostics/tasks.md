# Tasks: Retrieval Shape Diagnostics

**Input**: Design documents from `/specs/060-retrieval-strategy-diagnostics/`
**Prerequisites**: plan.md, spec.md

**Tests**: Backend tests must be written before implementation.

## Phase 1: Setup

- [x] T001 Create Speckit spec, plan, and checklist for retrieval shape diagnostics.
- [x] T002 Inspect retrieval trace, telemetry, OpenAPI, and history seams before implementation.

## Phase 2: Foundational

- [x] T003 [P] Add failing unit coverage for retrieval shape selection.
- [x] T004 [P] Add failing unit coverage for retrieval skill diagnostic validation and telemetry metadata.
- [x] T004a [P] Add unit coverage for shared skill run resolution, partial overrides, fallback, and no mutation.

## Phase 3: User Story 1 - See The Retrieval Shape Used (Priority: P1)

**Goal**: Retrieval answer responses expose shape metadata through the existing trace graph.

**Independent Test**: `POST /api/v1/retrieval/answer` returns trace summary shape fields and a `shape_selection` stage.

- [x] T005 [P] [US1] Add failing contract coverage for retrieval answer trace shape fields.
- [x] T006 [US1] Implement retrieval shape selector and query-shape types.
- [x] T007 [US1] Add shape resolution to retrieval diagnostics and trace assembly.
- [x] T008 [US1] Add valid `SkillDiagnostic` mapping for `retrieval.answer`.
- [x] T008a [US1] Define `retrieval.answer` as data-only skill steps and shape overrides.

## Phase 4: User Story 2 - Preserve Shape Diagnostics In History (Priority: P2)

**Goal**: Existing audit-backed history/debug replay preserves additive shape diagnostics.

**Independent Test**: Chat history debug payload includes the stored retrieval trace shape fields.

- [x] T009 [P] [US2] Add failing integration or unit coverage for history replay of shape diagnostics.
- [x] T010 [US2] Verify existing chat/search audit metadata paths preserve the additive trace shape.

## Phase 5: User Story 3 - Audit Retrieval Shape Through Telemetry (Priority: P3)

**Goal**: Retrieval telemetry can be grouped by skill, shape, query shape, surface, and fallback.

**Independent Test**: Telemetry unit coverage observes expected tags and metadata without raw content.

- [x] T011 [P] [US3] Add failing telemetry unit coverage.
- [x] T012 [US3] Extend retrieval pipeline telemetry event metadata and tags.
- [x] T012a Define EE-only `human_contact.request` skill steps and register them through the EE module.
- [x] T012b Remove English regex and keyword-based human-contact deterministic triggers.

## Phase 6: Contracts, Docs, And Generated Artifacts

- [x] T013 Update code-first OpenAPI schemas and regenerate backend OpenAPI artifacts.
- [x] T014 Sync TypeScript SDK generated types and verify SDK build.
- [x] T015 Update docs to describe activity/debug graph retrieval shape diagnostics.
- [x] T016 Run backend unit, contract, integration, build, and SDK validations.

## Dependencies & Execution Order

- T003-T005 and T009-T011 are test-first tasks and should precede implementation.
- T006-T008 complete the response trace MVP.
- T010 confirms persistence through existing audit metadata; no schema changes are expected.
- T013-T015 must follow implementation because they reflect final additive contracts.
