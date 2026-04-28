# Tasks: Structured Lexical Query Plans

**Input**: Design documents from `/specs/053-lexical-query-plan/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Tests**: Backend TDD is required. Test tasks must be completed and verified failing before implementation tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm feature artifacts and existing seams

- [x] T001 Create Speckit plan in `specs/053-lexical-query-plan/plan.md`
- [x] T002 [P] Create research notes in `specs/053-lexical-query-plan/research.md`
- [x] T003 [P] Create data model in `specs/053-lexical-query-plan/data-model.md`
- [x] T004 [P] Create validation quickstart in `specs/053-lexical-query-plan/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add tested lexical alternative normalization before user-story behavior is wired

- [x] T005 [P] Add failing lexical alternative normalization tests in `backend/tests/unit/lexical-query-plan.test.ts`
- [x] T006 Implement lexical alternative normalization in `backend/src/modules/retrieval/domain/lexicalQueryPlan.ts`
- [x] T007 Run lexical normalization tests from `backend/`

---

## Phase 3: User Story 1 - Retrieve exact alternatives from one user question (Priority: P1) MVP

**Goal**: Search bounded lexical alternatives from one user question without changing retrieval pipeline stage contracts.

**Independent Test**: A query rewrite result containing OR-style lexical alternatives produces multiple existing retrieval subqueries and lexical retrieval branches.

### Tests for User Story 1

- [x] T008 [P] [US1] Add failing query rewrite tests for OR-style lexical alternatives in `backend/tests/unit/query-rewrite-subqueries.test.ts`
- [x] T009 [P] [US1] Add failing lexical backend parser tests in `backend/tests/unit/hybrid-retrieval-search.test.ts`

### Implementation for User Story 1

- [x] T010 [US1] Integrate lexical alternative normalization into `backend/src/modules/retrieval/services/queryRewriteService.ts`
- [x] T011 [US1] Update PostgreSQL lexical search query parsing in `backend/src/modules/retrieval/infra/lexicalSearch.ts`
- [x] T012 [US1] Update query rewrite prompt guidance in `backend/prompts/retrieval/query-rewrite-system.md`
- [x] T013 [US1] Run focused tests for `query-rewrite-subqueries`, `hybrid-retrieval-search`, and `retrieval-pipeline-stages` from `backend/`

---

## Phase 4: User Story 2 - Understand what lexical alternatives were searched (Priority: P2)

**Goal**: Keep diagnostics useful through existing subquery and branch traces.

**Independent Test**: Retrieval diagnostics show lexical branches generated from alternatives using existing trace structures.

### Tests for User Story 2

- [x] T014 [P] [US2] Verify diagnostics expectations in `backend/tests/unit/retrieval-trace-assembler.test.ts`

### Implementation for User Story 2

- [x] T015 [US2] Ensure normalized alternatives flow into existing branch diagnostics without changing `backend/src/modules/retrieval/services/retrievalTraceAssembler.ts`
- [x] T016 [US2] Run retrieval trace assembler tests from `backend/`

---

## Phase 5: User Story 3 - Keep lexical retrieval backend-swappable (Priority: P3)

**Goal**: Preserve contract stability and future backend replaceability.

**Independent Test**: Type checking and focused tests confirm `retrievalPipelineStages.ts` remains unchanged and lexical alternative behavior stays behind helper/search seams.

### Tests for User Story 3

- [x] T017 [P] [US3] Verify source-compatibility coverage in `backend/tests/unit/candidate-retrieval-branches.test.ts`

### Implementation for User Story 3

- [x] T018 [US3] Verify no changes to `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- [x] T019 [US3] Run TypeScript check from `backend/`

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final validation

- [x] T020 [P] Update retrieval docs if prompt or diagnostics behavior changed in `docs-portal/content/guides/retrieval-tuning.mdx`
- [x] T021 [P] Update settings help if lexical rewrite guidance changed in `frontend/docs/settings-docs/retrieval/lexical-rewrite-instructions.md`
- [x] T022 Run quickstart validation commands from `specs/053-lexical-query-plan/quickstart.md`
- [x] T023 Review `git diff --stat origin/main...` and confirm no public API or retrieval pipeline stage contract changes

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: Complete.
- **Foundational (Phase 2)**: Blocks all user stories.
- **User Story 1 (P1)**: Depends on foundational normalization.
- **User Story 2 (P2)**: Depends on US1 branch generation.
- **User Story 3 (P3)**: Depends on US1 implementation.
- **Polish**: Depends on desired user stories.

## Parallel Opportunities

- T005, T008, T009, T014, and T017 touch different tests and can be authored independently.
- Documentation tasks T020 and T021 can run after behavior is settled.

## Implementation Strategy

1. Complete lexical normalization helper and tests.
2. Wire helper into query rewrite while preserving retrieval pipeline stage contracts.
3. Improve PostgreSQL lexical parsing.
4. Verify diagnostics through existing branch structures.
5. Run typecheck and focused tests.
