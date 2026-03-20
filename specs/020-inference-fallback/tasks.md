# Tasks: Inference-Based Fallback Answers

**Input**: Design documents from `/specs/020-inference-fallback/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and MUST appear before implementation tasks (TDD per constitution).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Architecture**: All changes slot into existing modules per plan.md ownership. `chatService.ts` remains orchestration-only. `retrievalPipelineService.ts` is untouched.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Database migration and domain model extension needed by all stories

- [ ] T001 Create migration file to add `inference_answer_enabled` column in `backend/migrations/XXX_add_inference_answer_enabled.sql`
- [ ] T002 Add `inferenceAnswerEnabled: boolean` field to `RetrievalSettingsRecord` and `RetrievalSettingsInput` interfaces, add default `false` to `defaultRetrievalSettings()`, and add validation in `validateRetrievalSettings()` in `backend/src/modules/settings/domain/retrievalSettings.ts`
- [ ] T003 Add `inference_answer_enabled` to SELECT, INSERT, UPDATE clauses and `mapSettings` function in `backend/src/db/repositories/retrievalSettingsRepository.ts`

**Checkpoint**: Setting field exists end-to-end in domain, persistence, and DB. No user-facing behavior yet.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: API contract changes that both user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Add `inferenceAnswerEnabled: z.boolean()` to `updateSettingsSchema` in `backend/src/app/http/routes/settingsRoutes.ts`
- [ ] T005 [P] Add `source: "retrieval" | "inference"` field to response payloads in both `sendChatJson` and `sendChatSse` (`done` event) in `backend/src/app/http/presenters/chatPresenter.ts`
- [ ] T006 [P] Add `inferenceAnswerEnabled: boolean` to `RetrievalSettings` interface and `source?: 'retrieval' | 'inference'` to chat response type in `frontend/lib/api.ts`

**Checkpoint**: Foundation ready — API accepts and returns the new fields. User story implementation can begin.

---

## Phase 3: User Story 1 — Admin Enables Inference Fallback Toggle (Priority: P1) 🎯 MVP

**Goal**: Workspace admin can toggle inference fallback on/off in retrieval settings and it persists.

**Independent Test**: Toggle on → save → reload → verify persisted. Toggle off → save → verify reverted.

### Tests for User Story 1 (REQUIRED for backend)

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T007 [P] [US1] Write unit test for `inferenceAnswerEnabled` field validation (true/false/missing) in retrieval settings domain tests
- [ ] T008 [P] [US1] Write integration test for PUT /settings/retrieval with `inferenceAnswerEnabled` field — verify persistence and GET round-trip

### Implementation for User Story 1

- [ ] T009 [US1] Add "Inference Fallback" toggle in the "Response Style" section of `RetrievalSettingsPanel` (after citation display toggle) using existing `Switch` + label + description pattern in `frontend/components/dashboard/settings-view.tsx`

**Checkpoint**: Admin can toggle inference fallback on/off and it persists. Feature toggle is the gate for Story 2.

---

## Phase 4: User Story 2 — User Gets Inference Answer When No Documents Match (Priority: P1)

**Goal**: When inference fallback is enabled and retrieval returns zero contexts, call LLM with inference prompt and return a general-knowledge answer tagged with `source: "inference"`.

**Independent Test**: Enable toggle → ask a question with no matching documents → verify LLM-generated answer (not static message) with `source: "inference"` in API response.

### Tests for User Story 2 (REQUIRED for backend)

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US2] Write unit test for `buildInferencePrompt` method in `promptBuilder` — verify prompt omits Retrieved Context section, includes warmth/custom instructions, includes disclaimer instruction, and omits citation formatting rules
- [ ] T011 [P] [US2] Write unit test for `chatService` streaming path — when `contexts.length === 0` and `inferenceAnswerEnabled === true`, verify LLM is called with inference prompt and response has `source: "inference"`
- [ ] T012 [P] [US2] Write unit test for `chatService` non-streaming path — same conditions, verify inference answer returned with `source: "inference"`
- [ ] T013 [P] [US2] Write unit test for `chatService` — when `contexts.length === 0` and `inferenceAnswerEnabled === false`, verify static message returned (existing behavior preserved)
- [ ] T014 [P] [US2] Write unit test for `chatService` — when inference LLM call fails, verify fallback to static message and error logging

### Implementation for User Story 2

- [ ] T015 [US2] Add `buildInferencePrompt(params)` method to `PromptBuilder` in `backend/src/modules/retrieval/services/promptBuilder.ts` — include system instruction, warmth instruction, custom instruction, inference disclaimer, conversation history, user question; omit Retrieved Context section and citation rules
- [ ] T016 [US2] Update streaming path in `chatService.ts` (around line 185) — when `contexts.length === 0` AND `inferenceAnswerEnabled`: build inference prompt via `promptBuilder.buildInferencePrompt(...)`, call `chatGateway.streamAnswer(...)`, tag response with `source: "inference"`; wrap in try/catch that falls back to static message on failure
- [ ] T017 [US2] Update non-streaming path in `chatService.ts` (around line 293) — same branching logic as T016 for the non-streaming code path
- [ ] T018 [US2] Ensure `source: "retrieval"` is set on all existing document-grounded responses in `chatService.ts` for backward-compatible tagging

**Checkpoint**: Full inference fallback works end-to-end. API responses correctly tagged. Feature is functional (MVP complete).

---

## Phase 5: User Story 3 — User Sees Visual Distinction for Inference Answers (Priority: P2)

**Goal**: Inference-based messages display a visual indicator in the chat UI and hide citation UI.

**Independent Test**: Trigger inference answer → verify banner/label visible → verify no citation links shown. Trigger retrieval answer → verify no inference indicator shown.

### Implementation for User Story 3

- [ ] T019 [US3] Add inference answer indicator to chat message rendering in the frontend — display "Answered from general knowledge — not based on your documents" banner when `source === "inference"`
- [ ] T020 [US3] Hide citation/source-documents UI for messages where `source === "inference"` in the chat view

**Checkpoint**: All user stories complete. Inference answers are visually distinct.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validation and cleanup

- [ ] T021 Run quickstart.md validation — execute all manual test scenarios from `specs/020-inference-fallback/quickstart.md`
- [ ] T022 Verify existing retrieval-based chat flows are unaffected (no regression in document-grounded answers)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2
- **User Story 2 (Phase 4)**: Depends on Phase 2 (and Phase 3 for the toggle to exist, but can be developed in parallel since the setting field already exists from Phase 1)
- **User Story 3 (Phase 5)**: Depends on Phase 4 (needs `source` field in responses)
- **Polish (Phase 6)**: Depends on all stories complete

### User Story Dependencies

- **User Story 1 (P1)**: Independent after Phase 2 — no dependencies on other stories
- **User Story 2 (P1)**: Can start after Phase 2 — functionally independent of US1 (the setting field exists from Phase 1; the toggle UI from US1 is a separate concern)
- **User Story 3 (P2)**: Depends on US2 — needs `source` field in chat responses to render the indicator

### Within Each User Story

- Backend tests MUST be written and FAIL before implementation
- Domain/model changes before service changes
- Service changes before transport/presenter changes
- Core implementation before integration

### Parallel Opportunities

- T002, T003 can run in parallel (different files) after T001
- T004, T005, T006 can all run in parallel (different files)
- T007, T008 can run in parallel (different test files)
- T010–T014 can all run in parallel (different test cases)
- T019, T020 can run in parallel (different UI concerns)
- US1 and US2 can start in parallel after Phase 2

---

## Parallel Example: User Story 2

```bash
# Launch all tests for User Story 2 together:
Task: "Unit test for buildInferencePrompt in promptBuilder tests"
Task: "Unit test for chatService streaming path with inference fallback"
Task: "Unit test for chatService non-streaming path with inference fallback"
Task: "Unit test for chatService with inference disabled (existing behavior)"
Task: "Unit test for chatService inference LLM failure fallback"

# After tests fail, implement in order:
Task: "Add buildInferencePrompt to promptBuilder"
Task: "Update streaming path in chatService"
Task: "Update non-streaming path in chatService"
Task: "Tag existing responses with source: retrieval"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (migration + domain + repository)
2. Complete Phase 2: Foundational (API schema + presenter + frontend types)
3. Complete Phase 3: User Story 1 (toggle UI)
4. Complete Phase 4: User Story 2 (inference answer generation)
5. **STOP and VALIDATE**: Test full flow — toggle on, ask question with no docs, verify inference answer
6. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → field exists end-to-end
2. Add US1 → admin can toggle → Deploy
3. Add US2 → inference answers work → Deploy (MVP!)
4. Add US3 → visual distinction → Deploy (Complete)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently testable
- Total tasks: 22
- Tasks per story: US1 = 3, US2 = 9, US3 = 2, Setup = 3, Foundational = 3, Polish = 2
- Suggested MVP scope: US1 + US2 (Phases 1–4)
- All tasks follow checklist format: checkbox, ID, labels, file paths
