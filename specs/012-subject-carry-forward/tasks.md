# Tasks: Conversational Subject Continuity

**Input**: Design documents from `/specs/012-subject-carry-forward/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and MUST appear before implementation tasks for each user story.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. `US1`, `US2`, `US3`)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Align feature artifacts and additive retrieval diagnostics contract with the implementation workspace

- [ ] T001 Confirm feature artifacts and validation path in `/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/quickstart.md`
- [ ] T002 [P] Review current retrieval seams in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/queryRewriteService.ts` and `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalPipelineService.ts` against `/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/plan.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the retrieval-domain seams and types required by all user stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 [P] Add carried-subject and continuity diagnostic types to `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [ ] T004 [P] Introduce normalized subject identity helpers in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/subjectIdentityService.ts`
- [ ] T005 [P] Create subject convergence decision seam in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/subjectConvergenceService.ts`
- [ ] T006 [P] Create subject continuity state seam in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/subjectContinuityService.ts`
- [ ] T007 Extend retrieval telemetry assembly for subject continuity diagnostics in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts`
- [ ] T008 Refactor `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalPipelineService.ts` to depend on the new convergence and continuity seams without moving feature logic into `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/chat/services/chatService.ts`

**Checkpoint**: Retrieval-domain foundation is ready; user stories can now be implemented incrementally.

---

## Phase 3: User Story 1 - Keep Follow-Ups On Subject (Priority: P1) 🎯 MVP

**Goal**: Preserve a coherent grounded subject across context-dependent follow-up turns without changing the raw user message.

**Independent Test**: Ask a first-turn subject question, then a low-content or shorthand follow-up; confirm retrieval remains anchored to the previously grounded subject and diagnostics show `reused` or `newly_established` appropriately.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T009 [P] [US1] Add unit tests for normalized subject identity and convergence metrics in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/entity-integrity.test.ts`
- [ ] T010 [P] [US1] Add unit tests for structured carried-subject rewrite input and deterministic fallback behavior in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/chat-retrieval.domain.test.ts`
- [ ] T011 [P] [US1] Add integration tests for first-turn subject establishment and context-dependent follow-up reuse in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [ ] T012 [P] [US1] Extend candidate subject normalization and aggregation in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/candidatePreparationService.ts`
- [ ] T013 [US1] Replace regex-first follow-up rewriting with structured retrieval-intent handling in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/queryRewriteService.ts`
- [ ] T014 [US1] Implement raw-vs-subject-biased path evaluation and subject reuse outcomes in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [ ] T015 [US1] Wire subject reuse diagnostics into chat retrieval info output in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts`

**Checkpoint**: User Story 1 should be independently functional and testable as the MVP.

---

## Phase 4: User Story 2 - Drop Stale Subject Bias When Topic Changes (Priority: P1)

**Goal**: Prefer current-turn evidence over stale carried subject state and clear or replace the carried subject when the topic changes.

**Independent Test**: Ground one turn on subject A, then ask a current-turn question that explicitly names subject B or causes raw retrieval to converge elsewhere; confirm the carried subject is replaced or cleared instead of reused.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T016 [P] [US2] Add unit tests for topic-change and raw-vs-biased disagreement outcomes in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/entity-integrity.test.ts`
- [ ] T017 [P] [US2] Add integration tests for explicit subject replacement and disagreement-driven clearing in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 2

- [ ] T018 [US2] Implement current-turn override and disagreement handling in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/subjectContinuityService.ts`
- [ ] T019 [US2] Update retrieval pipeline decision wiring for `replaced`, `cleared`, and `unresolved` outcomes in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [ ] T020 [US2] Extend diagnostics payload with winner, runner-up, and path disagreement metrics in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`

**Checkpoint**: User Stories 1 and 2 should both work independently, with topic-change safeguards visible in diagnostics.

---

## Phase 5: User Story 3 - Preserve Safe Multi-Subject And Ambiguous Behavior (Priority: P2)

**Goal**: Avoid forcing a single carried subject for comparison, ambiguous, shorthand, or zero-pronoun turns where current evidence does not support one winner.

**Independent Test**: Run comparison and ambiguous follow-up fixtures, including zero-pronoun or multilingual shorthand cases, and confirm the system preserves separate subjects or remains unresolved.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T021 [P] [US3] Add unit tests for comparative, ambiguous, and zero-pronoun continuity decisions in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/entity-integrity.test.ts`
- [ ] T022 [P] [US3] Add integration tests for comparison preservation, ambiguous follow-ups, and multilingual shorthand fixtures in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 3

- [ ] T023 [US3] Implement ambiguity and comparative blocking rules in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/subjectConvergenceService.ts`
- [ ] T024 [US3] Extend subject continuity decisions for low-content, elliptical, and zero-pronoun turns in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/subjectContinuityService.ts`
- [ ] T025 [US3] Preserve multi-subject retrieval context selection without single-subject collapse in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/retrieval/services/retrievalPipelineService.ts`

**Checkpoint**: All user stories should now be independently functional and safe for ambiguity/comparison scenarios.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, docs alignment, and regression safety

- [ ] T026 [P] Update retrieval continuity contract notes in `/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/contracts/chat-diagnostics.openapi.yaml`
- [ ] T027 [P] Add or refresh focused unit coverage for telemetry serialization in `/Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/hybrid-retrieval-info.test.ts`
- [ ] T028 Run quickstart validation commands from `/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/quickstart.md` and record any gaps in `/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and benefits from US1 continuity seams
- **User Story 3 (Phase 5)**: Depends on Foundational completion and the continuity outcomes introduced in US1/US2
- **Polish (Phase 6)**: Depends on all targeted user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: MVP and first delivery slice
- **User Story 2 (P1)**: Builds on the same continuity seams to handle topic change safely
- **User Story 3 (P2)**: Extends the same seams for ambiguity, comparison, and zero-pronoun behavior

### Within Each User Story

- Backend tests MUST be written and fail before implementation
- New retrieval-domain seams should be implemented before orchestration wiring
- `chatService.ts` and `promptBuilder.ts` must remain responsibility-limited
- Diagnostics updates should land with the domain behavior they describe

### Parallel Opportunities

- Foundational tasks T003-T007 can run in parallel before T008
- US1 tests T009-T011 can run in parallel
- US2 tests T016-T017 can run in parallel
- US3 tests T021-T022 can run in parallel
- Polish tasks T026-T027 can run in parallel before T028

## Parallel Example: User Story 1

```bash
Task: "Add unit tests for normalized subject identity and convergence metrics in /Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/entity-integrity.test.ts"
Task: "Add unit tests for structured carried-subject rewrite input and deterministic fallback behavior in /Users/dm/code/hivec-subject-carry-forward/backend/tests/unit/chat-retrieval.domain.test.ts"
Task: "Add integration tests for first-turn subject establishment and context-dependent follow-up reuse in /Users/dm/code/hivec-subject-carry-forward/backend/tests/integration/chat.integration.test.ts"
```

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup
2. Complete Foundational seams
3. Complete User Story 1
4. Validate User Story 1 independently before expanding scope

### Incremental Delivery

1. Deliver continuity MVP through User Story 1
2. Add topic-change safeguards in User Story 2
3. Add ambiguity/comparison/zero-pronoun safeguards in User Story 3
4. Finish with diagnostics and regression polish

## Notes

- All tasks follow the required checklist format with IDs, optional `[P]`, story labels where required, and exact file paths.
- The suggested MVP scope is **User Story 1**.
- Avoid monolithic changes in `/Users/dm/code/hivec-subject-carry-forward/backend/src/modules/chat/services/chatService.ts`; retrieval-domain services own the feature logic.
