# Tasks: Retrieval Pipeline Stages

**Input**: Design documents from `/specs/021-retrieval-stages/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED. New or updated tests must fail before implementation changes land.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the feature artifacts and target files are ready for implementation.

- [x] T001 Verify the active feature artifacts and target retrieval files in `specs/021-retrieval-stages/`, `backend/src/modules/retrieval/services/`, and `backend/tests/unit/`
- [x] T002 Review and preserve dependency wiring in `backend/tests/support/testApp.ts` before refactoring retrieval stage construction

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish safe architecture seams before changing pipeline behavior.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Add failing unit coverage for retrieval stage orchestration expectations in `backend/tests/unit/edge-cases.test.ts` or a new `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [x] T004 [P] Define shared retrieval stage input/output contracts in `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- [x] T005 [P] Extract query interpretation policy helpers from `backend/src/modules/retrieval/services/retrievalPipelineService.ts` into a focused stage module under `backend/src/modules/retrieval/services/`
- [x] T006 [P] Extract candidate retrieval and normalization stage seams under `backend/src/modules/retrieval/services/` while keeping `backend/src/modules/retrieval/infra/*.ts` unchanged
- [x] T007 Extract prompt assembly and diagnostics assembly stage seams under `backend/src/modules/retrieval/services/`
- [x] T008 Refactor `backend/src/modules/retrieval/services/retrievalPipelineService.ts` to orchestration-only wiring against the new stage seams

**Checkpoint**: Stage contracts and orchestration seams are in place, and the orchestrator can delegate major responsibilities.

---

## Phase 3: User Story 1 - Maintain Retrieval Flow Safely (Priority: P1) 🎯 MVP

**Goal**: Preserve the current retrieval pipeline contract while reducing `RetrievalPipelineService` to orchestration-focused coordination.

**Independent Test**: Run the updated retrieval pipeline unit tests and confirm callers still receive the same retrieval result shape without API changes.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T009 [P] [US1] Add orchestration contract assertions in `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [x] T010 [P] [US1] Validate unchanged retrieval result shape with `backend/tests/unit/chat-retrieval.domain.test.ts`

### Implementation for User Story 1

- [x] T011 [P] [US1] Implement a retrieval settings/context stage in `backend/src/modules/retrieval/services/retrievalContextStage.ts`
- [x] T012 [P] [US1] Implement a query interpretation stage in `backend/src/modules/retrieval/services/queryInterpretationStage.ts`
- [x] T013 [P] [US1] Implement a candidate retrieval stage in `backend/src/modules/retrieval/services/candidateRetrievalStage.ts`
- [x] T014 [US1] Update `backend/src/modules/retrieval/services/retrievalPipelineService.ts` to sequence the extracted stages and preserve the existing `run()` result contract
- [x] T015 [US1] Validate existing retrieval pipeline construction in `backend/tests/support/testApp.ts` remains compatible without caller API changes

**Checkpoint**: User Story 1 should preserve pipeline behavior while making the top-level orchestrator materially smaller.

---

## Phase 4: User Story 2 - Test Retrieval Stages Independently (Priority: P2)

**Goal**: Make major retrieval phases directly testable without relying only on one large orchestrator unit.

**Independent Test**: Run focused tests for stage modules plus the existing retrieval pipeline tests and confirm failures point to one stage at a time.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T016 [P] [US2] Add focused tests for query interpretation stage behavior in `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [x] T017 [P] [US2] Add focused tests for candidate retrieval/preparation stage behavior in `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [x] T018 [P] [US2] Add focused tests for prompt/diagnostics stage behavior through existing retrieval regressions in `backend/tests/unit/edge-cases.test.ts`

### Implementation for User Story 2

- [x] T019 [P] [US2] Implement a candidate preparation stage in `backend/src/modules/retrieval/services/candidatePreparationStage.ts`
- [x] T020 [P] [US2] Implement a context selection stage in `backend/src/modules/retrieval/services/contextSelectionStage.ts`
- [x] T021 [P] [US2] Implement a prompt assembly stage in `backend/src/modules/retrieval/services/promptAssemblyStage.ts`
- [x] T022 [P] [US2] Implement a diagnostics assembly stage in `backend/src/modules/retrieval/services/retrievalDiagnosticsStage.ts`
- [x] T023 [US2] Wire focused stage tests and orchestrator integration so `backend/tests/unit/retrieval-pipeline-stages.test.ts` and existing retrieval tests pass together

**Checkpoint**: Major retrieval phases can be validated in focused tests.

---

## Phase 5: User Story 3 - Preserve Module Ownership (Priority: P3)

**Goal**: Lock in clear ownership boundaries so future retrieval changes do not rebuild a god-file around the orchestrator.

**Independent Test**: Review file responsibilities and run regression tests to confirm the new seams preserve behavior while keeping transport, orchestration, domain logic, and infrastructure separated.

### Tests for User Story 3 (REQUIRED for backend)

- [x] T024 [P] [US3] Add architecture-oriented regression assertions in `backend/tests/unit/retrieval-pipeline-stages.test.ts` and preserve diagnostics/empty-candidate coverage in `backend/tests/unit/edge-cases.test.ts`

### Implementation for User Story 3

- [x] T025 [US3] Finalize ownership cleanup in `backend/src/modules/retrieval/services/retrievalPipelineService.ts` and adjacent stage modules so orchestration, domain rules, and infra responsibilities are separated
- [x] T026 [US3] Encode the intended ownership seams in `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- [x] T027 [US3] Reconcile retrieval-specific callers and test factories by preserving the existing `RetrievalPipelineService` construction path as the default composition path

**Checkpoint**: Ownership boundaries are explicit and preserved by code structure and tests.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and artifact alignment across all stories.

- [x] T028 [P] Run targeted backend validation from `specs/021-retrieval-stages/quickstart.md`
- [x] T029 Update completed task markers and note any residual risks in `specs/021-retrieval-stages/tasks.md`
- [x] T030 [P] Re-read `specs/021-retrieval-stages/spec.md`, `plan.md`, and changed code to verify scope fit before review handoff

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Starts after Foundational and establishes the MVP refactor
- **User Story 2 (Phase 4)**: Depends on User Story 1 stage wiring being in place
- **User Story 3 (Phase 5)**: Depends on the new stage modules existing and tested
- **Polish (Phase 6)**: Depends on all desired stories being complete

### Within Each User Story

- Tests must be written and fail before implementation tasks for that story
- New focused stage modules should land before orchestration wiring uses them
- Changes to the same file must remain sequential
- `RetrievalPipelineService` should only be revisited after the supporting stage seams exist

### Parallel Opportunities

- T004-T007 can progress in parallel where file ownership does not overlap
- Stage-specific tests in T016-T018 can be written in parallel
- Stage module implementations in T019-T022 can run in parallel if they avoid the same files
- Validation commands in T028 can run independently after implementation stabilizes

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1 to shrink `RetrievalPipelineService` while preserving behavior
3. Validate the unchanged retrieval contract before deeper stage-level test work

### Incremental Delivery

1. Establish stage contracts and orchestrator seams
2. Preserve behavior through the first extraction
3. Add focused tests for major stages
4. Finish ownership cleanup and final validation

### Parallel Team Strategy

If multiple engineers are involved after the foundational phase:

- Engineer A: query interpretation and context stages
- Engineer B: candidate retrieval/preparation stages
- Engineer C: prompt/diagnostics stages and validation wiring
