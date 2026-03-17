# Tasks: Assistive Rewrite Guardrails

**Input**: Design documents from `/specs/013-rewrite-guardrails/`
**Prerequisites**: `plan.md`, `spec.md`

**Tests**: Backend tests are required and must be written before implementation tasks in each story phase.

## Phase 1: Setup

**Purpose**: Align feature artifacts with the approved plan before code changes

- [x] T001 Create feature task breakdown in /Users/dm/code/hivec-rewrite-guardrails/specs/013-rewrite-guardrails/tasks.md

---

## Phase 2: Foundational

**Purpose**: Establish shared retrieval-domain seams before story-specific behavior changes

- [x] T002 Create structured rewrite and continuity decision types in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts
- [x] T003 Create rewrite validation policy helpers in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/

**Checkpoint**: Shared types and seams are ready for story implementation

---

## Phase 3: User Story 1 - Safe Referential Follow-Up Retrieval (Priority: P1) 🎯 MVP

**Goal**: Use rewrite assistance only when it is eligible and grounded, without letting it author continuity state

**Independent Test**: Follow-up referential turns run raw retrieval by default, run rewritten retrieval only for eligible proposals, and reject unsupported subject shifts

### Tests for User Story 1

- [x] T004 [P] [US1] Add query rewrite unit tests in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/unit/chat-retrieval.domain.test.ts
- [x] T005 [P] [US1] Add retrieval pipeline validation tests in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/unit/edge-cases.test.ts

### Implementation for User Story 1

- [x] T006 [US1] Refactor rewrite proposal generation and normalization in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/queryRewriteService.ts
- [x] T007 [US1] Implement rewrite eligibility, hallucination guard, and disagreement validation in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/
- [x] T008 [US1] Update retrieval orchestration to honor validation decisions in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/retrievalPipelineService.ts

---

## Phase 4: User Story 2 - Preserve Ambiguity and Relation Intent (Priority: P2)

**Goal**: Keep ambiguous and relational turns unresolved or properly separated instead of collapsing them into unsupported subject switches

**Independent Test**: Ambiguous and relation turns preserve uncertainty, retain related entities separately, and do not promote unsupported new active subjects

### Tests for User Story 2

- [x] T009 [P] [US2] Add ambiguity and relation handling tests in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/unit/chat-retrieval.domain.test.ts
- [x] T010 [P] [US2] Add integration-style ambiguity regression tests in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/integration/chat.integration.test.ts

### Implementation for User Story 2

- [x] T011 [US2] Extend rewrite proposal handling for turn kind, related entities, and explicit-subject precedence in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/queryRewriteService.ts
- [x] T012 [US2] Apply ambiguity-preserving continuity decisions in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/retrievalPipelineService.ts

---

## Phase 5: User Story 3 - Explainable Continuity Decisions (Priority: P3)

**Goal**: Record enough structured diagnostics to explain rewrite eligibility, disagreement handling, and continuity outcomes

**Independent Test**: Successful and rejected rewrite attempts expose diagnostics that explain whether rewrite ran and what continuity decision was taken

### Tests for User Story 3

- [x] T013 [P] [US3] Add retrieval diagnostics coverage in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/integration/chat.integration.test.ts
- [x] T014 [P] [US3] Add retrieval info presenter coverage in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/unit/hybrid-retrieval-info.test.ts

### Implementation for User Story 3

- [x] T015 [US3] Extend telemetry diagnostics shape in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts
- [x] T016 [US3] Emit continuity diagnostics in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts
- [x] T017 [US3] Present additive rewrite diagnostics in /Users/dm/code/hivec-rewrite-guardrails/backend/src/modules/retrieval/services/retrievalInfoPresenter.ts

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T018 Update test doubles for structured rewrite output in /Users/dm/code/hivec-rewrite-guardrails/backend/tests/support/testApp.ts
- [x] T019 Run targeted Vitest coverage for retrieval rewrite, pipeline, and chat diagnostics from /Users/dm/code/hivec-rewrite-guardrails/backend/tests/
- [x] T020 Mark completed tasks and summarize validation evidence in /Users/dm/code/hivec-rewrite-guardrails/specs/013-rewrite-guardrails/tasks.md

## Dependencies & Execution Order

- Phase 1 completes first.
- Phase 2 blocks all story work.
- User Story 1 is the MVP and should land before User Stories 2 and 3.
- User Story 2 depends on the structured rewrite seams from User Story 1.
- User Story 3 depends on the final continuity decision shape from User Stories 1 and 2.

## Implementation Strategy

1. Establish the shared rewrite and continuity decision model.
2. Land User Story 1 with failing tests first.
3. Extend the same seams for ambiguity and relation handling.
4. Add structured diagnostics after the decision path is stable.

## Validation Notes

- `npm run test:unit -- tests/unit/chat-retrieval.domain.test.ts tests/unit/edge-cases.test.ts tests/unit/hybrid-retrieval-info.test.ts`
  passed after installing backend dependencies.
- `npm run build` passed.
- `npm run test:integration -- tests/integration/document-chunking.integration.test.ts tests/integration/chat.integration.test.ts tests/integration/retrieval-benchmark.integration.test.ts`
  passed after updating the in-memory test harness to eagerly drain queued document-processing jobs.
