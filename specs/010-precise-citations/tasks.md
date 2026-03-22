# Tasks: Precise Citation Placement

**Input**: Design documents from `/specs/010-precise-citations/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before implementation. Frontend verification follows the approved spec.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm current citation surfaces and prepare feature artifacts

- [x] T001 Review `/Users/dm/code/radioso-precise-citations/specs/010-precise-citations/spec.md`, `/Users/dm/code/radioso-precise-citations/specs/010-precise-citations/plan.md`, and the current chat citation flow in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/` and `/Users/dm/code/radioso-precise-citations/frontend/components/dashboard/`
- [x] T002 [P] Refresh feature docs in `/Users/dm/code/radioso-precise-citations/specs/010-precise-citations/` as implementation details stabilize

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish deterministic citation seams before story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Write failing shared unit coverage for prompt/source numbering and answer normalization entry points in `/Users/dm/code/radioso-precise-citations/backend/tests/unit/answer-presentation.test.ts`
- [x] T004 [P] Add a focused citation-anchor format/parsing seam in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/`
- [x] T005 [P] Update grounded prompt construction to include stable source numbering instructions in `/Users/dm/code/radioso-precise-citations/backend/src/modules/retrieval/services/promptBuilder.ts`
- [x] T006 Replace heuristic placement wiring with deterministic normalization entry points in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/answerPresentationService.ts`

**Checkpoint**: Shared prompt and normalization seams are ready for story implementation

---

## Phase 3: User Story 1 - Read Precisely Cited Answers (Priority: P1) 🎯 MVP

**Goal**: Completed answers place citations exactly where the backend declares them

**Independent Test**: Generate a multi-claim answer and verify markers land on intended claims, not inside unrelated text

### Tests for User Story 1

- [x] T007 [P] [US1] Write failing exact-placement and malformed-anchor unit coverage in `/Users/dm/code/radioso-precise-citations/backend/tests/unit/answer-presentation.test.ts`
- [x] T008 [P] [US1] Write failing completed-response contract coverage for precise answer segments in `/Users/dm/code/radioso-precise-citations/backend/tests/contract/chat.contract.test.ts`
- [x] T009 [P] [US1] Write failing chat integration coverage for exact citation placement in `/Users/dm/code/radioso-precise-citations/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [x] T010 [US1] Implement strict citation-anchor parsing and validation in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/`
- [x] T011 [US1] Normalize visible citations and exact `answerSegments` in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/answerPresentationService.ts`
- [x] T012 [US1] Keep JSON chat completion responses aligned with the normalized citation output in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/chatService.ts`

**Checkpoint**: User Story 1 is functional and independently testable

---

## Phase 4: User Story 2 - Receive Stable Streaming Answers (Priority: P2)

**Goal**: Streamed answers remain readable in flight and finalize to the same precise citation layout

**Independent Test**: Stream an answer and verify final citation placement matches the non-streamed path

### Tests for User Story 2

- [x] T013 [P] [US2] Write failing streaming parity unit coverage in `/Users/dm/code/radioso-precise-citations/backend/tests/unit/chat-service-streaming.test.ts`
- [x] T014 [P] [US2] Write failing integration coverage for streamed completion citation normalization in `/Users/dm/code/radioso-precise-citations/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 2

- [x] T015 [US2] Apply the shared normalization path to SSE completion handling in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/chatService.ts`
- [x] T016 [US2] Preserve chunk-stream readability and completion metadata parity in `/Users/dm/code/radioso-precise-citations/backend/src/app/http/presenters/chatPresenter.ts` and `/Users/dm/code/radioso-precise-citations/frontend/lib/api.ts`

**Checkpoint**: User Stories 1 and 2 are independently functional

---

## Phase 5: User Story 3 - Avoid Broken Citation States (Priority: P3)

**Goal**: Invalid anchors fail safely without leaking placeholders or misleading citations

**Independent Test**: Force invalid anchors and verify only valid citations survive normalization

### Tests for User Story 3

- [x] T017 [P] [US3] Write failing malformed/unknown-anchor regression coverage in `/Users/dm/code/radioso-precise-citations/backend/tests/unit/answer-presentation.test.ts`
- [x] T018 [P] [US3] Write failing mixed-validity response coverage in `/Users/dm/code/radioso-precise-citations/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 3

- [x] T019 [US3] Implement invalid-anchor dropping, boundary deduplication, and readable fallback behavior in `/Users/dm/code/radioso-precise-citations/backend/src/modules/chat/services/`
- [x] T020 [US3] Preserve existing citation open behavior against normalized citations in `/Users/dm/code/radioso-precise-citations/frontend/components/dashboard/chat-citations.tsx`

**Checkpoint**: All user stories are independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, docs, and cleanup across stories

- [x] T021 Run targeted backend unit, contract, and integration suites in `/Users/dm/code/radioso-precise-citations/backend/tests/`
- [x] T022 Run `/Users/dm/code/radioso-precise-citations/backend` build verification
- [x] T023 Run `/Users/dm/code/radioso-precise-citations/frontend` build verification
- [x] T024 Mark completed tasks and refresh `/Users/dm/code/radioso-precise-citations/specs/010-precise-citations/quickstart.md` if validation steps drift

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on User Story 1 because streaming completion reuses the same normalized output contract
- **User Story 3 (Phase 5)**: Depends on User Stories 1 and 2 because invalid-anchor handling must preserve the final normalized contract
- **Polish (Phase 6)**: Depends on all desired story work being complete

### Within Each User Story

- Backend tests must be written and fail before implementation
- Prompt numbering changes land before parser-dependent behavior
- Focused parser/normalizer seams land before `chatService.ts` wiring
- Existing responsibility-limited files must stay transport-only or orchestration-only

### Parallel Opportunities

- T004 and T005 can run in parallel after T003 exists
- T007, T008, and T009 can run in parallel
- T013 and T014 can run in parallel
- T017 and T018 can run in parallel

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate exact placement in completed answers before touching streaming parity

### Incremental Delivery

1. Add prompt numbering and parsing seams
2. Replace heuristic placement with deterministic normalization
3. Extend the same normalization to streamed completions
4. Harden malformed-anchor handling and final regression verification
