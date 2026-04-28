# Tasks: Configurable Answer Support Policy

**Input**: Design documents from `/specs/034-answer-policy/`  
**Prerequisites**: [plan.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/plan.md), [spec.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/spec.md), [research.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/research.md), [data-model.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/data-model.md), [quickstart.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/quickstart.md), [retrieval-settings-contract.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/contracts/retrieval-settings-contract.md)

**Tests**: Backend tests are REQUIRED and MUST be written before implementation. Frontend verification follows the feature spec and existing repo practices.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare shared fixtures and test seams that multiple stories depend on.

- [ ] T001 [P] Extend shared chat and settings test fixtures in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/support/fakes.ts`
- [ ] T002 [P] Add answer-support policy placeholders to shared frontend API typings in `/Users/dm/conductor/workspaces/radioso/sacramento/frontend/lib/api.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the workspace setting and focused policy seams before any story-specific behavior is implemented.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 [P] Add failing retrieval settings domain coverage for `answerPolicy` defaults and validation in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [ ] T004 [P] Add failing settings contract coverage for `answerPolicy` in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/contract/settings.contract.test.ts`
- [ ] T005 [P] Add failing unit coverage for policy application seams in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/answer-support-validator.test.ts`
- [ ] T006 Implement the answer-support policy enum, defaults, and validation in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/settings/domain/retrievalSettings.ts`
- [ ] T007 Persist and read `answerPolicy` through `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/db/repositories/retrievalSettingsRepository.ts`
- [ ] T008 Add code-first retrieval settings schema support for `answerPolicy` in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/app/http/openapi/document.ts`
- [ ] T009 Wire `answerPolicy` through retrieval settings transport in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/app/http/routes/settingsRoutes.ts`

**Checkpoint**: Workspace policy storage and contract seams are ready for story work.

---

## Phase 3: User Story 1 - Choose How Strict Grounding Enforcement Should Be (Priority: P1) 🎯 MVP

**Goal**: Retrieval-backed answers follow `strict`, `warn`, or `off`, with strict mode using a bounded generated non-verification notice in the user’s language.

**Independent Test**: Configure each mode, trigger retrieval-backed unsupported content, and verify strict replacement, warn preservation, and off behavior independently.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T010 [P] [US1] Add failing strict/warn/off validator behavior tests in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/answer-support-validator.test.ts`
- [ ] T011 [P] [US1] Add failing authenticated chat policy integration coverage in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/integration/chat.integration.test.ts`
- [ ] T012 [P] [US1] Add failing public chat policy contract coverage in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/contract/public-chat.contract.test.ts`
- [ ] T013 [P] [US1] Add failing streaming-path coverage for strict replacement behavior in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 1

- [ ] T014 [P] [US1] Create focused answer-support policy helpers in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/answerPolicy.ts`
- [ ] T015 [P] [US1] Create bounded strict-mode unsupported-notice generation in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/unsupportedNoticeGenerator.ts`
- [ ] T016 [US1] Update answer validation types for policy-aware outcomes in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/answerSupportValidationTypes.ts`
- [ ] T017 [US1] Apply strict/warn/off policy behavior in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/answerSupportValidator.ts`
- [ ] T018 [US1] Update answer-outcome classification in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/assistantTurnOutcomeClassifier.ts`
- [ ] T019 [US1] Wire workspace policy into authenticated and anonymous/public chat orchestration in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/chatService.ts`

**Checkpoint**: Policy modes work end to end for chat behavior without any settings UI changes.

---

## Phase 4: User Story 2 - Configure Policy In Retrieval Settings (Priority: P2)

**Goal**: Workspace admins can view, save, and reload `strict`, `warn`, or `off` through the retrieval settings API and UI.

**Independent Test**: Save the policy in retrieval settings, reload it, and confirm the configured mode is then reflected in later chat behavior for that workspace.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T020 [P] [US2] Extend retrieval settings contract and OpenAPI schema assertions in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/contract/settings.contract.test.ts`
- [ ] T021 [P] [US2] Add retrieval settings persistence coverage for older-client omission behavior in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/integration/document-settings.integration.test.ts`

### Implementation for User Story 2

- [ ] T022 [P] [US2] Extend retrieval settings service flow for `answerPolicy` in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/settings/services/retrievalSettingsService.ts`
- [ ] T023 [P] [US2] Update frontend retrieval settings client typing and requests in `/Users/dm/conductor/workspaces/radioso/sacramento/frontend/lib/api.ts`
- [ ] T024 [US2] Add the answer-support policy control and copy to `/Users/dm/conductor/workspaces/radioso/sacramento/frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
- [ ] T025 [US2] Regenerate generated OpenAPI artifacts in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/sacramento/backend/openapi.json`

**Checkpoint**: Admins can configure the policy through the supported settings surfaces.

---

## Phase 5: User Story 3 - Preserve Debuggability Across Policy Modes (Priority: P3)

**Goal**: Operators can see which answer-support policy applied, whether validation ran, and whether the answer was modified in stored chat debug/history views.

**Independent Test**: Exercise each mode on retrieval-backed unsupported content and inspect history/debug output to confirm the policy and modification state are visible.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T026 [P] [US3] Add failing chat history debug coverage for `answerPolicy` in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/chat-history-service.test.ts`
- [ ] T027 [P] [US3] Add failing retrieval-trace/history streaming assertions for policy-aware metadata in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 3

- [ ] T028 [P] [US3] Persist `answerPolicy` in assistant-turn audit metadata within `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/chatService.ts`
- [ ] T029 [P] [US3] Surface `answerPolicy` in history/debug mapping within `/Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/chat/services/chatHistoryService.ts`
- [ ] T030 [US3] Expose the active policy in the dashboard history/debug view at `/Users/dm/conductor/workspaces/radioso/sacramento/frontend/components/dashboard/chat-history-view.tsx`

**Checkpoint**: Policy-driven answer handling is inspectable in existing debug/history flows.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, cleanup, and documented validation across all stories.

- [ ] T031 [P] Run focused backend validation for settings, validator, chat, and public chat flows in `/Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/`
- [ ] T032 [P] Run frontend verification for retrieval settings changes in `/Users/dm/conductor/workspaces/radioso/sacramento/frontend/`
- [ ] T033 Run the quickstart validation scenarios from `/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/quickstart.md`
- [ ] T034 Update feature documentation status and mark completed items in `/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-policy/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on Foundational completion and can proceed after or alongside US1 once shared seams land.
- **User Story 3 (Phase 5)**: Depends on Foundational completion and should follow the audit metadata shape introduced in US1.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; no dependency on the settings UI.
- **User Story 2 (P2)**: Depends on Foundational; benefits from US1 runtime behavior being available for end-to-end validation.
- **User Story 3 (P3)**: Depends on US1 audit behavior and can finalize after US2 if UI wording needs alignment.

### Within Each User Story

- Backend tests MUST be written and FAIL before implementation.
- Shared seams and focused extractions land before orchestration changes.
- Domain helpers before service orchestration.
- Settings/backend contract work before frontend wiring.
- Story completion and independent validation before moving to the next priority.

### Parallel Opportunities

- Phase 1 fixture and typing tasks marked `[P]` can run in parallel.
- Phase 2 tests can run in parallel before the shared settings implementation tasks.
- In US1, unit/integration/contract/streaming tests can be authored in parallel, and the policy helper plus notice generator can be implemented in parallel.
- In US2, backend service updates and frontend API typing can proceed in parallel before the UI control is wired.
- In US3, backend history mapping and frontend debug presentation can proceed in parallel once audit metadata is available.

---

## Parallel Example: User Story 1

```bash
# Launch failing tests for policy behavior together:
Task: "Add failing strict/warn/off validator behavior tests in backend/tests/unit/answer-support-validator.test.ts"
Task: "Add failing authenticated chat policy integration coverage in backend/tests/integration/chat.integration.test.ts"
Task: "Add failing public chat policy contract coverage in backend/tests/contract/public-chat.contract.test.ts"

# Launch focused domain helpers together:
Task: "Create focused answer-support policy helpers in backend/src/modules/chat/services/answerPolicy.ts"
Task: "Create bounded strict-mode unsupported-notice generation in backend/src/modules/chat/services/unsupportedNoticeGenerator.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Verify strict/warn/off behavior independently for chat.
5. Demo the policy behavior before wiring the settings UI.

### Incremental Delivery

1. Complete Setup + Foundational to make the workspace policy storable.
2. Add User Story 1 and validate runtime behavior.
3. Add User Story 2 and validate admin configuration.
4. Add User Story 3 and validate operator visibility.
5. Finish with Polish and quickstart verification.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together.
2. Once Foundational is done:
   - Developer A: User Story 1 runtime policy behavior
   - Developer B: User Story 2 settings/API/UI
   - Developer C: User Story 3 diagnostics/history
3. Rejoin for polish, OpenAPI regeneration, and focused validation.

---

## Notes

- `[P]` tasks touch different files with no unresolved dependencies.
- `[US1]`, `[US2]`, and `[US3]` keep traceability back to approved user stories.
- Backend TDD is mandatory for this feature.
- `backend/src/app/http/openapi/document.ts` is the source of truth for HTTP contract changes; `backend/openapi.yaml` and `backend/openapi.json` are generated outputs.
- Avoid monolithic tasks that push policy logic into `chatService.ts` or `settingsRoutes.ts`; keep the focused policy seams from `plan.md`.
