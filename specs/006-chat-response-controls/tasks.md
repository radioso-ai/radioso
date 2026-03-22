# Tasks: Chat Response Controls

**Input**: Design documents from `/specs/006-chat-response-controls/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before implementation. Frontend verification follows the approved spec and quickstart.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the feature artifacts and implementation seams

- [ ] T001 Review `/Users/dm/code/radioso/specs/006-chat-response-controls/plan.md` and align target modules in `/Users/dm/code/radioso/backend/src/modules` and `/Users/dm/code/radioso/frontend/components/dashboard`
- [ ] T002 [P] Add contract notes for response controls and optional citation metadata in `/Users/dm/code/radioso/backend/openapi.yaml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared response metadata and settings foundations before user-story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Write failing shared settings/domain validation tests in `/Users/dm/code/radioso/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [ ] T004 Write failing shared chat contract coverage for optional citation metadata in `/Users/dm/code/radioso/backend/tests/contract/chat.contract.test.ts`
- [ ] T005 [P] Add persistence support for response preferences in `/Users/dm/code/radioso/backend/src/db/migrations/` and `/Users/dm/code/radioso/backend/src/db/repositories/retrievalSettingsRepository.ts`
- [ ] T006 [P] Extend the settings domain and service types for response preferences in `/Users/dm/code/radioso/backend/src/modules/settings/domain/retrievalSettings.ts` and `/Users/dm/code/radioso/backend/src/modules/settings/services/retrievalSettingsService.ts`
- [ ] T007 [P] Extend settings transport schemas and frontend API types in `/Users/dm/code/radioso/backend/src/app/http/routes/settingsRoutes.ts` and `/Users/dm/code/radioso/frontend/lib/api.ts`
- [ ] T008 Create shared chat response metadata types and presenter support in `/Users/dm/code/radioso/backend/src/modules/chat/services/chatService.ts` and `/Users/dm/code/radioso/backend/src/app/http/presenters/chatPresenter.ts`

**Checkpoint**: Settings and chat metadata foundations are ready for story implementation

---

## Phase 3: User Story 1 - Adjust response tone (Priority: P1) 🎯 MVP

**Goal**: Let an account owner save a warmth level from 1 to 10 and have new answers reflect that tone

**Independent Test**: Save a warmth level, reload settings, send a chat message, and verify the value persists and is applied to answer-generation instructions

### Tests for User Story 1

- [ ] T009 [P] [US1] Write failing settings contract coverage for `warmthLevel` in `/Users/dm/code/radioso/backend/tests/contract/settings.contract.test.ts`
- [ ] T010 [P] [US1] Write failing prompt-builder unit coverage for warmth instructions in `/Users/dm/code/radioso/backend/tests/unit/chat-retrieval.domain.test.ts`
- [ ] T011 [P] [US1] Write failing integration coverage for persisted warmth behavior in `/Users/dm/code/radioso/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [ ] T012 [US1] Implement response warmth defaults and validation in `/Users/dm/code/radioso/backend/src/modules/settings/domain/retrievalSettings.ts`
- [ ] T013 [US1] Persist and return `warmthLevel` in `/Users/dm/code/radioso/backend/src/db/repositories/retrievalSettingsRepository.ts` and `/Users/dm/code/radioso/backend/src/app/http/routes/settingsRoutes.ts`
- [ ] T014 [US1] Add backend response-style instruction building in `/Users/dm/code/radioso/backend/src/modules/retrieval/services/promptBuilder.ts` or a focused extracted module under `/Users/dm/code/radioso/backend/src/modules/retrieval/services/`
- [ ] T015 [US1] Wire warmth-aware prompt generation through `/Users/dm/code/radioso/backend/src/modules/retrieval/services/retrievalPipelineService.ts` and `/Users/dm/code/radioso/backend/src/modules/chat/services/chatService.ts`
- [ ] T016 [US1] Add the warmth slider to `/Users/dm/code/radioso/frontend/components/dashboard/settings-view.tsx`
- [ ] T017 [US1] Extend frontend settings state and API handling for `warmthLevel` in `/Users/dm/code/radioso/frontend/lib/api.ts`

**Checkpoint**: User Story 1 is functional and independently testable

---

## Phase 4: User Story 2 - Receive answers without forced follow-up prompts (Priority: P2)

**Goal**: Prevent answers from ending with engagement questions unless clarification is required

**Independent Test**: Ask a fully specified question and confirm the answer does not end with a conversational prompt, then ask an ambiguous question and confirm a clarification question is allowed

### Tests for User Story 2

- [ ] T018 [P] [US2] Write failing unit coverage for closing-question policy in `/Users/dm/code/radioso/backend/tests/unit/chat-retrieval.domain.test.ts`
- [ ] T019 [P] [US2] Write failing integration coverage for no-trailing-engagement-question behavior in `/Users/dm/code/radioso/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 2

- [ ] T020 [US2] Add closing-question policy instructions to backend prompt construction in `/Users/dm/code/radioso/backend/src/modules/retrieval/services/promptBuilder.ts` or its extracted response-instruction module
- [ ] T021 [US2] Ensure chat orchestration applies the clarification-only question policy in `/Users/dm/code/radioso/backend/src/modules/chat/services/chatService.ts`
- [ ] T022 [US2] Update settings copy to explain clarification-only questions in `/Users/dm/code/radioso/frontend/components/dashboard/settings-view.tsx`

**Checkpoint**: User Stories 1 and 2 work independently

---

## Phase 5: User Story 3 - View cleaner optional citations (Priority: P3)

**Goal**: Render citations only when enabled and use backend-owned structured metadata to avoid repeated source markers

**Independent Test**: Ask a grounded question, verify deduplicated claim-level citations when enabled, then disable citations and verify the same answer renders without markers

### Tests for User Story 3

- [ ] T023 [P] [US3] Write failing settings contract coverage for `citationDisplayEnabled` in `/Users/dm/code/radioso/backend/tests/contract/settings.contract.test.ts`
- [ ] T024 [P] [US3] Write failing chat contract coverage for optional `answerSegments` and optional `citations` in `/Users/dm/code/radioso/backend/tests/contract/chat.contract.test.ts`
- [ ] T025 [P] [US3] Write failing unit coverage for citation assignment and deduplication in `/Users/dm/code/radioso/backend/tests/unit/chat-retrieval.domain.test.ts`
- [ ] T026 [P] [US3] Write failing integration coverage for optional citation rendering behavior in `/Users/dm/code/radioso/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 3

- [ ] T027 [US3] Implement `citationDisplayEnabled` defaults, validation, and persistence in `/Users/dm/code/radioso/backend/src/modules/settings/domain/retrievalSettings.ts` and `/Users/dm/code/radioso/backend/src/db/repositories/retrievalSettingsRepository.ts`
- [ ] T028 [US3] Add backend citation-assignment and deduplication support in a focused module under `/Users/dm/code/radioso/backend/src/modules/retrieval/services/`
- [ ] T029 [US3] Return optional `citations` and `answerSegments` from `/Users/dm/code/radioso/backend/src/modules/chat/services/chatService.ts` and `/Users/dm/code/radioso/backend/src/app/http/presenters/chatPresenter.ts`
- [ ] T030 [US3] Extend frontend chat types and completion handling for `answerSegments` in `/Users/dm/code/radioso/frontend/lib/api.ts` and `/Users/dm/code/radioso/frontend/lib/chat-context.tsx`
- [ ] T031 [US3] Replace positional citation heuristics with backend-owned rendering in `/Users/dm/code/radioso/frontend/components/dashboard/chat-citations.tsx`
- [ ] T032 [US3] Add a citation display control and supporting copy in `/Users/dm/code/radioso/frontend/components/dashboard/settings-view.tsx`

**Checkpoint**: All user stories are independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final consistency, docs, and verification across stories

- [ ] T033 [P] Update shared API docs in `/Users/dm/code/radioso/backend/openapi.yaml` and `/Users/dm/code/radioso/frontend/lib/api.ts`
- [ ] T034 Run backend test suites for affected coverage in `/Users/dm/code/radioso/backend/tests/`
- [ ] T035 Run frontend lint and verify settings/chat rendering flows in `/Users/dm/code/radioso/frontend/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and reuses US1 response-instruction seams
- **User Story 3 (Phase 5)**: Depends on Foundational completion and reuses the chat metadata seam
- **Polish (Phase 6)**: Depends on all completed story work

### User Story Dependencies

- **US1**: Independent after Foundational phase
- **US2**: Depends on the backend response-instruction seam created in US1 but remains independently testable
- **US3**: Depends on the shared chat response metadata seam from Foundational phase and remains independently testable

### Within Each User Story

- Backend tests must be written and fail before implementation
- Shared schema and persistence work lands before transport and UI wiring
- Focused domain modules are added before orchestration is expanded
- Frontend rendering consumes backend metadata and must not reintroduce citation heuristics

### Parallel Opportunities

- T005, T006, and T007 can run in parallel after foundational test tasks exist
- Within US1, T009, T010, and T011 can run in parallel
- Within US3, T023, T024, T025, and T026 can run in parallel
- Frontend settings work and backend domain work can overlap once contracts are stable

---

## Parallel Example: User Story 3

```bash
Task: "Write failing settings contract coverage for citationDisplayEnabled in /Users/dm/code/radioso/backend/tests/contract/settings.contract.test.ts"
Task: "Write failing chat contract coverage for optional answerSegments and optional citations in /Users/dm/code/radioso/backend/tests/contract/chat.contract.test.ts"
Task: "Write failing unit coverage for citation assignment and deduplication in /Users/dm/code/radioso/backend/tests/unit/chat-retrieval.domain.test.ts"
Task: "Write failing integration coverage for optional citation rendering behavior in /Users/dm/code/radioso/backend/tests/integration/chat.integration.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate saved warmth settings and warmth-aware answers

### Incremental Delivery

1. Add response warmth controls
2. Add clarification-only closing-question behavior
3. Add optional structured citation rendering and deduplication
4. Run final verification across JSON and SSE paths

### Parallel Team Strategy

1. One engineer owns backend settings and prompt policy
2. One engineer owns backend citation metadata
3. One engineer owns frontend settings and rendering once backend contracts settle

## Notes

- Total tasks: 35
- User story task counts: US1 = 9, US2 = 5, US3 = 10
- Suggested MVP scope: Phase 3 / User Story 1
- All tasks follow the required checklist format with task id, labels, and file paths
