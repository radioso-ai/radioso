# Tasks: History-Aware Expansive Suggestions

**Input**: Design documents from `/specs/047-expansive-followups/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and must be written before implementation for each affected slice. Frontend unit coverage should be added for grouped suggestion rendering.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing while preserving the module boundaries declared in `plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (`[US1]`, `[US2]`, etc.)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh the approved design artifacts and lock the implementation seams before editing runtime code.

- [x] T001 Reconcile the approved feature artifacts in `specs/047-expansive-followups/spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/suggestion-groups-contract.md`, and `quickstart.md`
- [x] T002 [P] Review the current suggestion, chat history, and chat rendering seams in `backend/src/modules/chat/services/`, `backend/src/modules/chat/types/`, `frontend/lib/`, and `frontend/components/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce grouped suggestion contracts and shared types before story-specific behavior changes.

**⚠️ CRITICAL**: No user story implementation starts before this phase is complete.

- [x] T003 [P] Add failing backend contract coverage for grouped suggestion items in `backend/tests/contract/chat.contract.test.ts`
- [x] T004 [P] Add failing shared backend/frontend type expectations for grouped suggestion items in `backend/tests/unit/chat-presenter.test.ts` and `frontend/lib/api.ts`-adjacent coverage if present
- [x] T005 Extend grouped suggestion types in `backend/src/modules/chat/types/chatResponses.ts`
- [x] T006 Update chat presenter and code-first OpenAPI schemas for grouped suggestions in `backend/src/app/http/presenters/chatPresenter.ts` and `backend/src/app/http/openapi/document.ts`
- [x] T007 Update frontend chat response and streaming types for grouped suggestions in `frontend/lib/api.ts`
- [x] T008 Regenerate `backend/openapi.yaml` and `backend/openapi.json` via the existing generation flow

**Checkpoint**: Shared contracts understand grouped suggestions and can support richer behavior.

---

## Phase 3: User Story 1 - Stay Aligned With The Conversation Goal (Priority: P1) 🎯 MVP

**Goal**: Make exploratory suggestion planning history-aware so broader suggestions follow the active conversation intent rather than only the latest answer text.

**Independent Test**: Run multi-turn exploratory chat scenarios and confirm broader suggestions remain aligned with the ongoing subject or task.

### Tests for User Story 1

- [x] T009 [P] [US1] Add failing unit coverage for history-aware suggestion planning in `backend/tests/unit/chat-service-streaming.test.ts`
- [x] T010 [P] [US1] Add failing integration coverage for multi-turn expansive alignment in `backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [x] T011 [P] [US1] Add a focused conversation-intent snapshot helper under `backend/src/modules/chat/services/`
- [x] T012 [P] [US1] Extend `backend/prompts/chat/conversation-mode-suggestions.md` to accept recent conversation context and grouped planning instructions
- [x] T013 [US1] Refactor `backend/src/modules/chat/services/conversationModeExpansionService.ts` to consume conversation intent and current grounded contexts without bloating `chatService.ts`
- [x] T014 [US1] Wire history-aware planning inputs from `backend/src/modules/chat/services/chatService.ts` into the expansion service

**Checkpoint**: Exploratory planning follows recent conversation intent and remains independently testable.

---

## Phase 4: User Story 2 - Choose Between Going Deeper And Going Broader (Priority: P1)

**Goal**: Return explicit deeper vs broader suggestions and render them consistently across chat surfaces.

**Independent Test**: Trigger exploratory turns that return one or both groups and confirm both dashboard and public chat render the groups correctly.

### Tests for User Story 2

- [x] T015 [P] [US2] Add failing backend unit coverage for grouped parsing and filtering in `backend/tests/unit/chat-service-streaming.test.ts`
- [x] T016 [P] [US2] Add failing frontend grouped rendering coverage in `frontend/tests/unit/chat-message-thread.test.tsx`

### Implementation for User Story 2

- [x] T017 [P] [US2] Extend suggestion parsing/filtering in `backend/src/modules/chat/services/conversationModeExpansionService.ts` to classify `deeper` and `broader`
- [x] T018 [P] [US2] Add a reusable grouped suggestion renderer under `frontend/components/`
- [x] T019 [US2] Update `frontend/components/dashboard/chat-message-thread.tsx` to use the grouped renderer
- [x] T020 [US2] Update `frontend/components/chat/public-chat-shell.tsx` and related contexts to render grouped suggestions consistently

**Checkpoint**: Users can distinguish between deeper and broader follow-ups in both chat surfaces.

---

## Phase 5: User Story 3 - Keep Expansive Suggestions Grounded And Predictable (Priority: P1)

**Goal**: Preserve omission, deduplication, standalone clarity, and brevity override behavior while grouped suggestions are richer.

**Independent Test**: Exercise exploratory turns with weak support, duplicate candidates, pronoun-heavy candidates, and directness requests.

### Tests for User Story 3

- [x] T021 [P] [US3] Add failing unit coverage for grouped omission and duplicate rejection in `backend/tests/unit/chat-service-streaming.test.ts`
- [x] T022 [P] [US3] Add failing integration coverage for brevity override and unsupported broader omission in `backend/tests/integration/chat.integration.test.ts`
- [x] T023 [P] [US3] Add failing public-chat parity coverage in `backend/tests/integration/anonymous-chat.integration.test.ts`

### Implementation for User Story 3

- [x] T024 [US3] Preserve and adapt duplicate filtering, standalone wording, and omission rules in `backend/src/modules/chat/services/conversationModeExpansionService.ts`
- [x] T025 [US3] Ensure suggestion enable/count settings and brevity override behavior still apply through `backend/src/modules/chat/services/chatService.ts`
- [x] T026 [US3] Preserve grouped suggestion compatibility in `frontend/lib/chat-context.tsx` and `frontend/lib/anonymous-chat-context.tsx`

**Checkpoint**: Richer suggestions stay grounded, bounded, and predictable.

---

## Phase 6: User Story 4 - Reuse Suggestions Reliably Across Chat Surfaces (Priority: P2)

**Goal**: Preserve compatibility for history replay and suggestion-click provenance while grouped suggestions ship.

**Independent Test**: Reopen conversations with legacy suggestions, trigger grouped suggestions, and click both types from dashboard and public chat.

### Tests for User Story 4

- [x] T027 [P] [US4] Add failing history compatibility coverage in `backend/tests/unit/chat-history-service.test.ts`
- [x] T028 [P] [US4] Add failing frontend compatibility coverage for legacy suggestion arrays in `frontend/tests/unit/chat-message-thread.test.tsx`

### Implementation for User Story 4

- [x] T029 [P] [US4] Preserve history mapping compatibility in `backend/src/modules/chat/services/chatHistoryService.ts`
- [x] T030 [P] [US4] Keep suggestion-click provenance unchanged in `frontend/components/chat/public-chat-shell.tsx` and `frontend/components/dashboard/chat-message-thread.tsx`
- [x] T031 [US4] Ensure legacy flat suggestions remain renderable through the new grouped renderer in `frontend/components/`

**Checkpoint**: Existing history and click behavior remain stable after the grouped rollout.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finish docs, validation, and final cleanup across stories.

- [x] T032 [P] Update operator-facing docs in `frontend/docs/settings-docs/retrieval/conversation-mode.md` and `frontend/docs/settings-docs/retrieval/suggested-questions-enabled.md`
- [x] T033 [P] Review and update `readme.md` if the operator-facing suggestion behavior explanation now needs grouped expansive guidance
- [x] T034 Reconcile task completion and artifact wording in `specs/047-expansive-followups/`
- [x] T035 Run the validation scenarios from `specs/047-expansive-followups/quickstart.md`
- [x] T036 Run targeted backend and frontend test commands for the completed feature
- [x] T037 Perform final cleanup to confirm responsibility-limited files did not absorb domain logic

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all story work
- **User Stories (Phases 3-6)**: Depend on Foundational completion
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational and delivers the MVP behavior fix
- **US2 (P1)**: Starts after Foundational but depends on grouped contracts from Phase 2
- **US3 (P1)**: Starts after US1/US2 seams exist and hardens the richer behavior
- **US4 (P2)**: Starts after grouped payloads and rendering exist

### Within Each User Story

- Backend tests MUST fail before implementation
- Shared types and contracts land before UI rendering changes
- Focused helper modules land before `chatService.ts` wiring changes
- Shared grouped renderer lands before both chat surfaces adopt it

### Parallel Opportunities

- Foundational contract/type tasks can be split across backend and frontend files
- Backend history-aware planner work can run in parallel with frontend grouped renderer work once Phase 2 is complete
- Doc updates can run in parallel with final validation

---

## Parallel Example: User Story 2

```bash
# Backend grouping work
Task: "Extend suggestion parsing/filtering in backend/src/modules/chat/services/conversationModeExpansionService.ts to classify deeper and broader"

# Frontend shared rendering work
Task: "Add a reusable grouped suggestion renderer under frontend/components/"
```

---

## Implementation Strategy

### MVP First (US1)

1. Complete Setup + Foundational
2. Deliver history-aware exploratory planning
3. Validate multi-turn alignment before broadening the UI surface changes

### Incremental Delivery

1. Add grouped contracts and types
2. Deliver history-aware backend planning
3. Add grouped UI rendering
4. Harden omission, dedupe, and brevity behavior
5. Preserve history compatibility and provenance
6. Finish docs and validation

### Review Strategy

1. Complete implementation and validation
2. Run a separate senior-engineer review focused on regressions, trust boundaries, and missing coverage
3. Create the PR, then run the requested review and CEO review loops and iterate until only non-significant issues remain

## Notes

- All backend HTTP contract changes must flow through `backend/src/app/http/openapi/document.ts`
- Generated OpenAPI files must never be hand-edited
- Runtime prompt assets belong under `backend/prompts/`
- Keep guided mode more conservative than exploratory mode throughout the implementation
