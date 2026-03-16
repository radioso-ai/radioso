# Tasks: Precise Citation Placement

**Input**: Design documents from `/specs/010-precise-citations/`  
**Prerequisites**: plan.md (required), spec.md (required), research.md, quickstart.md  
**Tests**: Backend tests are REQUIRED and MUST appear before implementation tasks.

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Confirm feature artifacts exist and paths are correct in `specs/010-precise-citations/plan.md`
- [x] T002 [P] Add/refresh quickstart scenarios in `specs/010-precise-citations/quickstart.md`

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T003 [P] Add unit tests for citation-anchor parsing in `backend/tests/unit/citation-anchors.test.ts`
- [x] T004 [P] Add unit tests for streaming anchor sanitization in `backend/tests/unit/citation-anchors.test.ts`
- [x] T005 Update prompt context numbering and citation instruction in `backend/src/modules/retrieval/services/promptBuilder.ts` (tests-first via contract/integration adjustments)

## Phase 3: User Story 1 - Read Precisely Cited Answers (Priority: P1) 🎯 MVP

**Goal**: Completed chat answers use backend-declared anchor placement, and only explicitly cited sources are rendered.

**Independent Test**: Run unit tests for anchor parsing and run chat contract tests to confirm `citations` and `answerSegments` are deterministic and exclude uncited sources.

### Tests for User Story 1

- [x] T006 [P] Update contract tests for chat payload to cover anchor-based placement in `backend/tests/contract/chat.contract.test.ts`
- [x] T007 [P] Update unit tests around answer presentation to assert no heuristic placement fallback in `backend/tests/unit/answer-presentation.test.ts`

### Implementation for User Story 1

- [x] T008 [P] Implement citation-anchor parser in `backend/src/modules/chat/services/citationAnchorParser.ts`
- [x] T009 Replace heuristic placement logic in `backend/src/modules/chat/services/answerPresentationService.ts` with deterministic parsing
- [x] T010 Ensure message persistence uses anchor-stripped answer text in `backend/src/modules/chat/services/chatService.ts`

## Phase 4: User Story 2 - Receive Stable Streaming Answers (Priority: P2)

**Goal**: Streaming does not expose raw `[[N]]` syntax and completion metadata matches the displayed answer.

**Independent Test**: Run unit tests for sanitizer and streaming tests for chat service.

### Tests for User Story 2

- [x] T011 [P] Add/adjust streaming unit tests to assert anchors are not emitted in `backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 2

- [x] T012 Implement streaming chunk sanitizer in `backend/src/modules/chat/services/citationAnchorSanitizer.ts`
- [x] T013 Wire sanitizer into streaming path in `backend/src/modules/chat/services/chatService.ts` without breaking completion parsing

## Phase 5: User Story 3 - Avoid Broken Citation States (Priority: P3)

**Goal**: Malformed/invalid anchors are removed or ignored; valid anchors still work.

**Independent Test**: Unit tests cover invalid anchor patterns and mixed valid/invalid sequences.

### Tests for User Story 3

- [x] T014 [P] Add invalid/malformed anchor cases to `backend/tests/unit/citation-anchors.test.ts`

### Implementation for User Story 3

- [x] T015 Ensure parser removes raw placeholder syntax and excludes invalid anchors in `backend/src/modules/chat/services/citationAnchorParser.ts`

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T016 Run `backend` unit + contract test suites and record results in PR description
- [x] T017 Run `frontend` build to ensure citation rendering remains compatible
- [x] T018 Update feature docs if any contract details changed in `backend/openapi.yaml`
