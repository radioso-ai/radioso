# Tasks: Conversation Modes

**Input**: Design documents from `/specs/041-conversation-modes/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and must be written before implementation for each affected slice. Frontend verification follows the feature specification and existing dashboard flows.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing while preserving the module boundaries declared in `plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (`[US1]`, `[US2]`, etc.)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh the feature scaffolding and ensure the delivery artifacts stay in sync.

- [x] T001 Reconcile the approved feature artifacts in `specs/041-conversation-modes/spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/conversation-mode-contract.md`, and `quickstart.md`
- [x] T002 [P] Review existing chat/history/settings seams in `backend/src/modules/chat/services/`, `backend/src/modules/retrieval/services/`, `backend/src/modules/settings/`, and `frontend/components/dashboard/settings/` to confirm task file targets before implementation

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the new workspace setting and the minimal shared types/metadata seams before any story-specific behavior changes.

**⚠️ CRITICAL**: No user story implementation starts before this phase is complete.

- [x] T003 [P] Add failing retrieval settings domain coverage for `conversationMode` defaults and validation in `backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [x] T004 [P] Add failing settings contract coverage for `conversationMode` in `backend/tests/contract/settings.contract.test.ts`
- [x] T005 [P] Add failing frontend API type expectations for `conversationMode` in `frontend/lib/api.ts`-adjacent verification or existing type-usage tests if present
- [x] T006 Implement `conversationMode` enum, default (`guided`), and validation in `backend/src/modules/settings/domain/retrievalSettings.ts`
- [x] T007 Persist and read `conversationMode` through `attribute_controls` in `backend/src/db/repositories/retrievalSettingsRepository.ts`
- [x] T008 Add `conversationMode` to settings transport parsing in `backend/src/app/http/routes/settingsRoutes.ts`
- [x] T009 Add `conversationMode` to the code-first settings schemas in `backend/src/app/http/openapi/document.ts`
- [x] T010 Update shared frontend retrieval settings types in `frontend/lib/api.ts`
- [x] T011 Regenerate `backend/openapi.yaml` and `backend/openapi.json` via the existing OpenAPI generation flow after schema changes land

**Checkpoint**: Workspace settings and contract seams understand `conversationMode`, so story work can begin.

---

## Phase 3: User Story 1 - Make The Assistant Feel Meaningfully Different By Mode (Priority: P1) 🎯 MVP

**Goal**: Deliver distinct factual/guided/exploratory behavior for supported answers while keeping the direct answer clearly separated from optional focused or expansive continuations.

**Independent Test**: Ask the same supported question in each mode and verify factual stays direct, guided adds up to two focused continuations, and exploratory adds a recognizable grounded discovery block.

### Tests for User Story 1

- [x] T012 [P] [US1] Add failing unit coverage for mode-specific response strategy instructions in `backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T013 [P] [US1] Add failing unit coverage for grounded expansion planning/composition in `backend/tests/unit/conversation-mode-composer.test.ts`
- [x] T014 [P] [US1] Add failing integration coverage for supported-answer mode differences in `backend/tests/integration/chat.integration.test.ts`
- [x] T015 [P] [US1] Add failing streaming parity coverage for conversation-mode metadata in `backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 1

- [x] T016 [P] [US1] Create a focused response-strategy instruction helper in `backend/src/modules/retrieval/services/conversationModeInstructionBuilder.ts`
- [x] T017 [P] [US1] Create bounded grounded expansion planner/composer modules in `backend/src/modules/chat/services/conversationExpansionPlanner.ts` and `backend/src/modules/chat/services/conversationExpansionComposer.ts`
- [x] T018 [P] [US1] Add any runtime prompt templates needed for conversation-mode generation under `backend/prompts/chat/`
- [x] T019 [US1] Wire conversation-mode instructions into prompt construction in `backend/src/modules/retrieval/services/promptBuilder.ts` and `backend/src/modules/retrieval/services/promptAssemblyStage.ts`
- [x] T020 [US1] Extend retrieval pipeline response settings to carry `conversationMode` in `backend/src/modules/retrieval/services/retrievalPipelineStages.ts` and `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [x] T021 [US1] Apply focused/expansive continuation composition for supported turns in `backend/src/modules/chat/services/chatService.ts` without moving domain logic into orchestration
- [x] T022 [US1] Add additive response metadata types for conversation mode and expansion state in `backend/src/modules/chat/types/chatResponses.ts`

**Checkpoint**: Supported answers behave distinctly by mode and remain independently testable.

---

## Phase 4: User Story 2 - Configure How Broadly The Assistant Responds (Priority: P1)

**Goal**: Let operators manage the new setting from the dashboard and ensure unsaved workspaces default to guided mode.

**Independent Test**: Save each mode from settings, reload, and confirm later chat turns reflect the saved mode while unsaved workspaces read back as guided.

### Tests for User Story 2

- [x] T023 [P] [US2] Extend settings contract assertions for guided default and save/read behavior in `backend/tests/contract/settings.contract.test.ts`
- [x] T024 [P] [US2] Add failing frontend settings interaction coverage for `conversationMode` in `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`-adjacent tests if present, or document manual verification if none exist

### Implementation for User Story 2

- [x] T025 [P] [US2] Add operator-facing setting docs for conversation mode in `frontend/docs/settings-docs/retrieval/conversation-mode.md`
- [x] T026 [P] [US2] Register the new settings doc in `frontend/components/dashboard/settings/settings-docs.ts`
- [x] T027 [US2] Add the `conversationMode` control and descriptive copy to `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
- [x] T028 [US2] Ensure settings save/load flow preserves `answerSupportPolicy` as a separate control in `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` and `frontend/lib/api.ts`

**Checkpoint**: Operators can configure the mode cleanly, and the settings surface reflects the product separation between conversation mode and trust policy.

---

## Phase 5: User Story 3 - Preserve Trust Boundaries Across All Modes (Priority: P1)

**Goal**: Ensure guided/exploratory behavior never bypasses `answerSupportPolicy`, and add per-turn brevity override behavior without turning it into another persisted setting.

**Independent Test**: Exercise supported, partially unsupported, fully unsupported, and no-context turns under each mode while keeping strict support policy active; also confirm an explicit “just the answer” request suppresses optional expansion.

### Tests for User Story 3

- [x] T029 [P] [US3] Add failing unit coverage for brevity-override detection and suppression behavior in `backend/tests/unit/conversation-mode-composer.test.ts`
- [x] T030 [P] [US3] Add failing unit coverage for strict-policy interaction with conversation mode in `backend/tests/unit/answer-support-validator.test.ts`
- [x] T031 [P] [US3] Add failing integration coverage for unsupported/no-context mode behavior and brevity override in `backend/tests/integration/chat.integration.test.ts`
- [x] T032 [P] [US3] Add failing public-chat parity coverage for `conversationMode` in `backend/tests/contract/public-chat.contract.test.ts` or `backend/tests/integration/anonymous-chat.integration.test.ts`

### Implementation for User Story 3

- [x] T033 [US3] Implement explicit brevity-override detection in a focused backend seam under `backend/src/modules/chat/services/`
- [x] T034 [US3] Apply conversation mode to unsupported and no-context answer composition in `backend/src/modules/chat/services/chatService.ts` and `backend/src/modules/chat/services/groundedMissResponseComposer.ts` without weakening `answerSupportPolicy`
- [x] T035 [US3] Ensure public/anonymous chat inherits the same workspace `conversationMode` behavior through `backend/src/app/http/routes/publicChatRoutes.ts` and existing service wiring

**Checkpoint**: Trust-policy behavior remains intact, and explicit user intent can suppress expansion for the current turn.

---

## Phase 6: User Story 4 - Inspect Which Mode Produced A Turn (Priority: P2)

**Goal**: Make conversation mode and expansion application inspectable in response payloads and history/debug views.

**Independent Test**: Generate factual, guided, and exploratory turns and verify operators can inspect the applied mode and whether expansion was used.

### Tests for User Story 4

- [x] T036 [P] [US4] Add failing unit coverage for conversation-mode debug mapping in `backend/tests/unit/chat-history-service.test.ts`
- [x] T037 [P] [US4] Add failing retrieval-trace/streaming assertions for conversation-mode metadata in `backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 4

- [x] T038 [P] [US4] Persist additive conversation-mode metadata in assistant-turn audit metadata within `backend/src/modules/chat/services/chatService.ts`
- [x] T039 [P] [US4] Surface conversation-mode metadata in history/debug mapping within `backend/src/modules/chat/services/chatHistoryService.ts`
- [x] T040 [P] [US4] Expose conversation-mode metadata through chat response payloads in `backend/src/modules/chat/types/chatResponses.ts` and related presenters if needed
- [x] T041 [US4] Render conversation-mode information in `frontend/components/dashboard/chat-history-view.tsx`

**Checkpoint**: Operators can inspect how the turn was shaped without a new debug endpoint.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, artifact sync, validation, and final cleanup across stories.

- [x] T042 [P] Review and update `readme.md` for operator-facing conversation-mode guidance if the retrieval settings section should expose the new control
- [x] T043 [P] Update any existing answer-support or retrieval settings docs that now need cross-references, including `frontend/docs/settings-docs/retrieval/answer-support-policy.md`
- [x] T044 Reconcile generated artifact wording and task completion state in `specs/041-conversation-modes/`
- [x] T045 Run the quickstart validation scenarios from `specs/041-conversation-modes/quickstart.md`
- [x] T046 Run targeted backend/frontend validation for the completed feature
- [x] T047 Perform final code cleanup and verify no responsibility-limited files absorbed out-of-scope logic

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all story work
- **User Stories (Phases 3-6)**: Depend on Foundational completion
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational; delivers the MVP behavior change
- **US2 (P1)**: Starts after Foundational; depends on shared settings support but is independently testable
- **US3 (P1)**: Starts after Foundational and reuses US1 seams for unsupported/no-context behavior
- **US4 (P2)**: Starts after Foundational and depends on conversation-mode metadata existing in the backend

### Within Each User Story

- Backend tests MUST fail before implementation
- Extract focused modules before wiring orchestration
- Settings/storage/schema changes land before behavior that depends on them
- History/debug surfaces come after additive metadata exists

### Parallel Opportunities

- Phase 2 tests and schema/storage tasks can be split across files
- US1 planner/composer and strategy-instruction helpers can be built in parallel
- US2 docs registration and UI control tasks can run in parallel
- US4 persistence and history/debug mapping tasks can run in parallel across backend/frontend files

---

## Parallel Example: User Story 1

```bash
# Launch failing backend coverage together:
Task: "Add failing unit coverage for mode-specific response strategy instructions in backend/tests/unit/chat-retrieval.domain.test.ts"
Task: "Add failing unit coverage for grounded expansion planning/composition in backend/tests/unit/conversation-mode-composer.test.ts"
Task: "Add failing integration coverage for supported-answer mode differences in backend/tests/integration/chat.integration.test.ts"

# Build focused modules in parallel:
Task: "Create a focused response-strategy instruction helper in backend/src/modules/retrieval/services/conversationModeInstructionBuilder.ts"
Task: "Create bounded grounded expansion planner/composer modules in backend/src/modules/chat/services/conversationExpansionPlanner.ts and backend/src/modules/chat/services/conversationExpansionComposer.ts"
Task: "Add runtime prompt templates under backend/prompts/chat/"
```

---

## Implementation Strategy

### MVP First (US1)

1. Complete Setup + Foundational
2. Deliver US1 with backend TDD
3. Validate supported-answer mode differences before broadening scope

### Incremental Delivery

1. Add `conversationMode` to settings and contracts
2. Deliver supported-answer shaping
3. Add operator configuration UI
4. Extend behavior to unsupported/no-context plus brevity override
5. Add debug/history observability
6. Finish docs and validation

### Review Strategy

1. Complete implementation and validation
2. Run a separate senior-engineer review pass focused on regressions, missing tests, and architecture drift
3. Prepare an engineering-manager review summary and PR description

## Notes

- [P] tasks touch different files and avoid same-file conflicts
- All backend HTTP contract changes must flow through `backend/src/app/http/openapi/document.ts`
- Generated OpenAPI files must never be hand-edited
- Runtime prompt assets belong under `backend/prompts/`
- Keep `answerSupportPolicy` and `conversationMode` separate throughout the implementation
