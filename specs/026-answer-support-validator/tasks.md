# Tasks: Answer Support Validator

**Input**: Design documents from `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED and must be written before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the current answer-generation, streaming, audit, and history seams before implementation begins.

- [x] T001 Review `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/spec.md`, `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/plan.md`, and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/tasks.md`
- [x] T002 [P] Inventory answer normalization and prompt touchpoints in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/answerPresentationService.ts`, `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/chatService.ts`, and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/retrieval/services/promptBuilder.ts`
- [x] T003 [P] Inventory audit/history and contract touchpoints in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/audit/services/auditService.ts`, `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/chatHistoryService.ts`, `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/app/http/openapi/document.ts`, and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/contract/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish focused validation and outcome-classification seams before story-specific wiring.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Write failing shared backend unit coverage for support classification and unsupported notice replacement in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/answer-support-validator.test.ts`
- [x] T005 [P] Write failing shared backend unit coverage for assistant-turn outcome classification in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/answer-support-validator.test.ts`
- [x] T006 [P] Create answer support validation types and constants in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/answerSupportValidationTypes.ts`
- [x] T007 [P] Create a focused answer support validator in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/answerSupportValidator.ts`
- [x] T008 [P] Create a focused assistant-turn outcome classifier in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/assistantTurnOutcomeClassifier.ts`
- [x] T009 Tighten claim-by-claim citation guidance in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/retrieval/services/promptBuilder.ts`

**Checkpoint**: Validation policy and answer-outcome seams exist outside `chatService.ts`.

---

## Phase 3: User Story 1 - Strip Unsupported Segments Before Delivery (Priority: P1) 🎯 MVP

**Goal**: Keep supported answer content, replace unsupported substantive content with an explicit unsupported notice, and never emit unvalidated grounded-answer text.

**Independent Test**: Ask a mixed-support question and verify the final JSON and SSE answer keep supported content while replacing unsupported substantive content with the explicit unsupported notice.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T010 [P] [US1] Write failing answer-presentation and validator integration coverage in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/answer-presentation.test.ts` and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/answer-support-validator.test.ts`
- [x] T011 [P] [US1] Write failing non-streaming and streaming chat-service coverage for validated delivery in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/chat-service-streaming.test.ts`
- [x] T012 [P] [US1] Write failing chat integration coverage for mixed, fully supported, and fully unsupported validated answers in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [x] T013 [US1] Extend `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/answerPresentationService.ts` to preserve the segment inputs needed for support validation
- [x] T014 [US1] Wire validated-answer generation into `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/chatService.ts` for non-stream responses
- [x] T015 [US1] Update `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/chatService.ts` so SSE buffers raw grounded answers and emits only validated chunks and final payloads

**Checkpoint**: User Story 1 is independently functional and safe for final delivery.

---

## Phase 4: User Story 2 - Record Violations As Degraded Outcomes (Priority: P2)

**Goal**: Persist validator-triggered rewrites as degraded assistant-turn outcomes instead of normal grounded success.

**Independent Test**: Trigger a validator rewrite and verify the persisted turn outcome is `grounded_degraded_unsupported_segments`, while fully supported and no-context turns remain distinct.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T016 [P] [US2] Write failing integration coverage for persisted degraded outcomes and no-context refusal distinction in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/integration/chat.integration.test.ts`
- [x] T017 [P] [US2] Write failing history/debug unit coverage for answer-outcome replay in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/chat-history-service.test.ts`

### Implementation for User Story 2

- [x] T018 [US2] Persist validation summaries and assistant-turn outcomes in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/chatService.ts`
- [x] T019 [US2] Extend `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/audit/services/auditService.ts` and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/chat/services/chatHistoryService.ts` to replay answer outcomes and validation summaries
- [x] T020 [US2] Update answer-outcome trace metadata in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/modules/retrieval/services/retrievalTracePresenter.ts`

**Checkpoint**: User Stories 1 and 2 are independently functional and persisted outcomes reflect validator-triggered degradation.

---

## Phase 5: User Story 3 - Preserve Debuggability Of Validation Decisions (Priority: P3)

**Goal**: Expose enough structured validation detail in stored turn diagnostics for engineers to understand what was kept, replaced, and downgraded.

**Independent Test**: Fetch conversation history after a validator rewrite and verify the assistant-message debug payload shows validation execution, modification status, and unsupported segment counts.

### Tests for User Story 3 (REQUIRED for backend)

- [x] T021 [P] [US3] Write failing contract coverage for additive validation debug fields in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/contract/chat.contract.test.ts`
- [x] T022 [P] [US3] Write failing OpenAPI contract coverage if schemas change in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/contract/openapi.contract.test.ts`

### Implementation for User Story 3

- [x] T023 [US3] Add additive history-debug schemas to `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/app/http/openapi/document.ts`
- [x] T024 [US3] Regenerate `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/openapi.json` from `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/src/app/http/openapi/document.ts`

**Checkpoint**: All user stories are independently functional and validation decisions are inspectable through existing diagnostics surfaces.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, docs alignment, and review readiness across all stories.

- [x] T025 [P] Refresh `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/quickstart.md` and `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/contracts/answer-support-debug-contract.md` if implementation details drift
- [x] T026 Run affected backend unit, integration, and contract suites in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/`
- [x] T027 [P] Run backend build verification in `/Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/`
- [x] T028 Re-read `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/spec.md`, `/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/plan.md`, and changed code for scope-fit self-check before review handoff

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion and is the recommended MVP
- **User Story 2 (Phase 4)**: Depends on User Story 1 because persisted outcomes require validated answer results
- **User Story 3 (Phase 5)**: Depends on User Story 2 because history/debug contract depends on persisted validation metadata
- **Polish (Phase 6)**: Depends on all desired story work being complete

### User Story Dependencies

- **US1**: Independent after Foundational and delivers the core enforcement guarantee
- **US2**: Depends on validated-answer outputs from US1
- **US3**: Depends on persisted validation metadata from US2

### Within Each User Story

- Backend tests must be written and fail before implementation
- Validation and outcome classification seams land before `chatService.ts` grows new orchestration
- Existing responsibility-limited files must stay transport-only or orchestration-only
- OpenAPI registry updates precede generated artifact refresh

### Parallel Opportunities

- T002 and T003 can run in parallel
- T005-T008 can run in parallel after T004 establishes the failing shared validator tests
- T010-T012 can run in parallel
- T016 and T017 can run in parallel
- T021 and T022 can run in parallel
- T025 and T027 can run in parallel once implementation stabilizes

---

## Parallel Example: User Story 1

```bash
Task: "Write failing answer-presentation and validator integration coverage in /Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/answer-presentation.test.ts and /Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/answer-support-validator.test.ts"
Task: "Write failing non-streaming and streaming chat-service coverage for validated delivery in /Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/unit/chat-service-streaming.test.ts"
Task: "Write failing chat integration coverage for mixed, fully supported, and fully unsupported validated answers in /Users/dm/conductor/workspaces/radioso/validator-enforcement/backend/tests/integration/chat.integration.test.ts"
```

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate JSON and SSE enforcement before touching persistence/debug work

### Incremental Delivery

1. Add focused validation and outcome-classification seams
2. Enforce validated delivery for JSON and SSE
3. Persist degraded assistant-turn outcomes and no-context distinctions
4. Expose structured validation debug through history/OpenAPI
5. Run final validation and review checks

## Notes

- Total tasks: 28
- User story task counts: US1 = 6, US2 = 5, US3 = 4
- Suggested MVP scope: Phase 3 / User Story 1
- Independent test criteria:
  - US1: final JSON and SSE answers never contain unsupported substantive text
  - US2: persisted outcomes distinguish supported, degraded, and no-context turns
  - US3: history debug exposes validation execution and unsupported segment counts
- All tasks follow the required checklist format with task id, labels, and file paths
