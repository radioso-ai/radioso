# Tasks: Universal Retrieval Quality Upgrade

**Input**: Design documents from `/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/`
**Prerequisites**: [plan.md](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/plan.md), [spec.md](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/spec.md), [research.md](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/research.md), [data-model.md](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/data-model.md), [contracts/openapi.yaml](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/contracts/openapi.yaml), [quickstart.md](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/quickstart.md)

**Tests**: Backend tests are REQUIRED and MUST be written before implementation tasks in each user story phase.

**Organization**: Tasks are grouped by user story so each story can be implemented and verified independently once foundational work is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel when dependencies are satisfied
- **[Story]**: Maps the task to a user story from the spec
- Every task includes an exact file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the repository artifacts and evaluation scaffolding for the retrieval-quality upgrade

- [x] T001 Align the feature documentation set in `/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/` and verify `plan.md`, `research.md`, `data-model.md`, `contracts/openapi.yaml`, and `quickstart.md` are current
- [x] T002 [P] Create retrieval evaluation fixtures for direct-answer, follow-up, noisy-corpus, and fallback scenarios in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/fixtures/retrieval-quality/`
- [x] T003 [P] Add quickstart-aligned validation notes for retrieval benchmark execution in `/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the retrieval-module seams and shared test harness required by all user stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 [P] Create shared retrieval pipeline types for context windows, rewritten queries, normalized candidates, reranked candidates, final prompt contexts, and execution diagnostics in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [x] T005 [P] Add shared retrieval-quality fixture builders and helper assertions in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/support/retrievalFixtures.ts`
- [x] T006 Refactor `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/retrievalPipelineService.ts` into an orchestration-only coordinator that delegates rewrite, candidate preparation, rerank, and prompt-context selection decisions to focused services
- [x] T007 [P] Extend `/private/tmp/hivec-improve-rag-pipeline/backend/tests/support/fakes.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/tests/support/testApp.ts` with fake gateways and fixture wiring for model-backed rewrite, semantic rerank, candidate normalization, and retrieval execution diagnostics
- [x] T008 [P] Add retrieval execution metadata plumbing contracts to `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/audit/services/auditService.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/src/shared/observability/logger.ts`

**Checkpoint**: Foundation ready. User story work can now proceed.

---

## Phase 3: User Story 1 - Reliable Grounding Across Retrieval Profiles (Priority: P1) 🎯 MVP

**Goal**: Make grounded answers and follow-up retrieval reliable across strict, moderate, and broad retrieval profiles by strengthening conversation-aware rewrite and first-pass retrieval quality

**Independent Test**: Ingest a representative corpus, enable multiple retrieval profiles for one account, ask direct and referential follow-up questions, and verify grounded answers with relevant citations instead of fallback

### Tests for User Story 1 (REQUIRED for backend)

- [x] T009 [P] [US1] Add unit tests for bounded conversation-context selection and rewrite gating in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T010 [P] [US1] Add unit tests for rewrite fallback and original-query preservation in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T011 [P] [US1] Add integration tests for direct and follow-up grounded chat across multiple retrieval profiles in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/chat.integration.test.ts`
- [x] T012 [P] [US1] Add persistence-oriented integration coverage for retrieval-text storage and title-aware chunk retrieval in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 1

- [x] T013 [P] [US1] Implement bounded conversation-context selection in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/conversationContextService.ts`
- [x] T014 [P] [US1] Implement model-backed retrieval-query rewriting with safe fallback in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/queryRewriteService.ts`
- [x] T015 [P] [US1] Add OpenAI-backed rewrite gateway support in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/chat/services/chatService.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/src/app/server/dependencies.ts`
- [x] T016 [P] [US1] Enrich ingestion-time retrieval text with stable document context in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/documents/services/documentIngestionService.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/embeddingService.ts`
- [x] T017 [US1] Update `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/retrievalPipelineService.ts` to retrieve candidates from both original and rewritten query paths while keeping the original user query for answer generation

**Checkpoint**: User Story 1 is independently functional and testable.

---

## Phase 4: User Story 2 - Broad Candidate Retrieval With Focused Final Context (Priority: P2)

**Goal**: Support broad first-pass retrieval while narrowing final contexts through candidate normalization, semantic reranking, and prompt-budgeted selection

**Independent Test**: Ingest overlapping-topic documents, run broad-retrieval queries, and verify that final cited contexts are narrower and more answer-bearing than raw vector ordering

### Tests for User Story 2 (REQUIRED for backend)

- [x] T018 [P] [US2] Add unit tests for candidate deduplication, threshold semantics, and source-merging behavior in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T019 [P] [US2] Add unit tests for semantic rerank ordering and prompt-context budget trimming in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T020 [P] [US2] Add integration tests for noisy-corpus narrowing and final citation quality in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/chat.integration.test.ts`
- [x] T021 [P] [US2] Add contract-regression coverage confirming `/api/v1/chat/` and `/api/v1/settings/retrieval` shapes remain unchanged in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/contract/chat.contract.test.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/tests/contract/settings.contract.test.ts`

### Implementation for User Story 2

- [x] T022 [P] [US2] Implement normalized candidate assembly and deduplication in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/candidatePreparationService.ts`
- [x] T023 [P] [US2] Implement semantic reranking in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/rerankService.ts`
- [x] T024 [P] [US2] Implement prompt-context budget selection in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/promptContextSelectorService.ts`
- [x] T025 [P] [US2] Update vector-search result handling and candidate annotations in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/infra/vectorSearch.ts`
- [x] T026 [US2] Update `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/promptBuilder.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/retrievalPipelineService.ts` to consume normalized candidates, reranked contexts, and prompt-budgeted final context sets

**Checkpoint**: User Stories 1 and 2 are independently functional and testable.

---

## Phase 5: User Story 3 - Predictable Fallback And Diagnostics (Priority: P3)

**Goal**: Preserve safe fallback behavior and expose enough retrieval execution evidence to debug rewrite, thresholding, rerank, and final context selection decisions

**Independent Test**: Simulate rewrite and rerank failures, verify chat still returns a grounded-or-safe-fallback result, and confirm request-level diagnostics show which retrieval stages ran or fell back

### Tests for User Story 3 (REQUIRED for backend)

- [x] T027 [P] [US3] Add unit tests for rewrite failure fallback, rerank failure fallback, and no-usable-context completion in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/edge-cases.test.ts`
- [x] T028 [P] [US3] Add integration tests for retrieval-stage fallback and diagnostics emission in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/chat.integration.test.ts`
- [x] T029 [P] [US3] Add persistence or integration coverage for retrieval execution metadata recording in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 3

- [x] T030 [P] [US3] Implement retrieval execution telemetry mapping in `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts`
- [x] T031 [P] [US3] Extend `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/retrievalPipelineService.ts` with explicit rewrite, retrieval, rerank, and final-context fallback states
- [x] T032 [P] [US3] Extend `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/chat/services/chatService.ts` to publish retrieval execution diagnostics without changing the public chat response shape
- [x] T033 [US3] Extend `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/audit/services/auditService.ts` and `/private/tmp/hivec-improve-rag-pipeline/backend/src/shared/observability/logger.ts` with retrieval-stage candidate counts, fallback markers, and final-context counts

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finalize evaluation workflow, documentation, and end-to-end validation for the upgraded retrieval pipeline

- [x] T034 [P] Build a repeatable retrieval benchmark harness in `/private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/retrieval-benchmark.integration.test.ts`
- [x] T035 [P] Document benchmark corpus expectations and validation steps in `/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/quickstart.md`
- [x] T036 [P] Synchronize the focused contract artifact in `/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/contracts/openapi.yaml` with the unchanged public API expectations
- [x] T037 Update `/private/tmp/hivec-improve-rag-pipeline/backend/.env.example`, `/private/tmp/hivec-improve-rag-pipeline/infra/.env.example`, and `/private/tmp/hivec-improve-rag-pipeline/infra/docker-compose.yml` if any new retrieval-assist configuration or documentation is required
- [x] T038 Run backend validation and live retrieval-quality verification, then record results in `/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup**: No dependencies
- **Phase 2: Foundational**: Depends on Phase 1 and blocks all user stories
- **Phase 3: User Story 1**: Depends on Phase 2
- **Phase 4: User Story 2**: Depends on Phase 2 and builds on the stronger retrieval-query and ingestion behavior from User Story 1
- **Phase 5: User Story 3**: Depends on Phases 2, 3, and 4 because fallback and diagnostics need the full upgraded retrieval path in place
- **Phase 6: Polish**: Depends on all completed user stories

### User Story Dependencies

- **User Story 1 (P1)**: Can begin after foundational work and is the MVP for universal retrieval quality
- **User Story 2 (P2)**: Depends on User Story 1 because candidate normalization and semantic rerank operate on the improved retrieval-query and ingestion path
- **User Story 3 (P3)**: Depends on User Stories 1 and 2 because fallback and diagnostics must cover the strengthened retrieval pipeline end to end

### Within Each User Story

- Write backend tests first and verify they fail before implementation
- Extract focused retrieval services before extending orchestration
- Keep `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/chat/services/chatService.ts` orchestration-only
- Keep `/private/tmp/hivec-improve-rag-pipeline/backend/src/app/http/routes/chatRoutes.ts` transport-only
- Keep `/private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/infra/vectorSearch.ts` vector-query-only

### Parallel Opportunities

- Setup tasks `T002` and `T003` can run in parallel after `T001`
- Foundational tasks `T004`, `T005`, `T007`, and `T008` can run in parallel before the retrieval-pipeline refactor is integrated in `T006`
- In User Story 1, `T009`-`T012` can run in parallel, then `T013`-`T016` can run in parallel before `T017`
- In User Story 2, `T018`-`T021` can run in parallel, then `T022`-`T025` can run in parallel before `T026`
- In User Story 3, `T027`-`T029` can run in parallel, then `T030`-`T032` can run in parallel before `T033`
- In Phase 6, `T034`, `T035`, and `T036` can run in parallel before final validation in `T038`

---

## Parallel Example: User Story 2

```bash
# Tests first
Task: "Add unit tests for candidate deduplication, threshold semantics, and source-merging behavior in /private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/chat-retrieval.domain.test.ts"
Task: "Add unit tests for semantic rerank ordering and prompt-context budget trimming in /private/tmp/hivec-improve-rag-pipeline/backend/tests/unit/chat-retrieval.domain.test.ts"
Task: "Add integration tests for noisy-corpus narrowing and final citation quality in /private/tmp/hivec-improve-rag-pipeline/backend/tests/integration/chat.integration.test.ts"

# Parallel implementation after tests fail
Task: "Implement normalized candidate assembly and deduplication in /private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/candidatePreparationService.ts"
Task: "Implement semantic reranking in /private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/rerankService.ts"
Task: "Implement prompt-context budget selection in /private/tmp/hivec-improve-rag-pipeline/backend/src/modules/retrieval/services/promptContextSelectorService.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases
2. Complete User Story 1
3. Validate direct grounded retrieval and referential follow-up retrieval across multiple retrieval profiles
4. Stop for review before broad-candidate reranking and telemetry work

### Incremental Delivery

1. Deliver User Story 1 to strengthen retrieval-query quality and first-pass recall
2. Add User Story 2 to improve noisy-corpus precision and final context selection
3. Add User Story 3 to harden fallback behavior and diagnostics
4. Finish with benchmark, documentation, and live validation

### Parallel Team Strategy

1. One engineer owns the foundational retrieval-pipeline refactor in Phase 2
2. One engineer can own User Story 1 rewrite and ingestion-quality improvements
3. One engineer can own User Story 2 candidate normalization and semantic rerank once User Story 1 seams are stable
4. One engineer can own User Story 3 fallback and telemetry once the upgraded retrieval path exists

---

## Notes

- Total tasks: 38
- User Story 1 tasks: 9
- User Story 2 tasks: 9
- User Story 3 tasks: 7
- Parallel opportunities identified in every phase after initial setup
- Suggested MVP scope: Phase 1, Phase 2, and User Story 1 only
- All tasks follow the required checklist format with IDs, optional `[P]`, story labels where required, and exact file paths
