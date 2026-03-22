# Tasks: Strict Grounding

**Input**: Design documents from `/specs/004-strict-grounding/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and MUST be written and fail before implementation.

**Organization**: Tasks are grouped by user story to preserve independent verification and modular ownership.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm design artifacts and baseline files before code changes

- [ ] T001 Review `/tmp/radioso-strict-grounding/specs/004-strict-grounding/spec.md`, `/tmp/radioso-strict-grounding/specs/004-strict-grounding/plan.md`, and `/tmp/radioso-strict-grounding/specs/004-strict-grounding/research.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Identify the narrow backend seams that will own the behavior change

- [ ] T002 Map retrieval-threshold ownership across `/tmp/radioso-strict-grounding/backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `/tmp/radioso-strict-grounding/backend/src/modules/chat/services/chatService.ts`, and `/tmp/radioso-strict-grounding/backend/src/modules/settings/domain/retrievalSettings.ts`

**Checkpoint**: The implementation seam is confirmed and user-story work can proceed.

---

## Phase 3: User Story 1 - Refuse Unsupported Questions (Priority: P1) 🎯 MVP

**Goal**: Out-of-corpus questions refuse safely instead of answering from weakly matched context

**Independent Test**: Ask a question not covered by the uploaded corpus and verify that chat returns the existing refusal response with the unchanged response shape.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T003 [P] [US1] Add unit coverage for hard-threshold retrieval behavior in `/tmp/radioso-strict-grounding/backend/tests/unit/edge-cases.test.ts`
- [ ] T004 [P] [US1] Add chat behavior coverage for out-of-corpus refusal in `/tmp/radioso-strict-grounding/backend/tests/contract/chat.contract.test.ts`

### Implementation for User Story 1

- [ ] T005 [US1] Remove similarity-threshold fallback from `/tmp/radioso-strict-grounding/backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [ ] T006 [US1] Preserve or update retrieval diagnostics for the no-fallback path in `/tmp/radioso-strict-grounding/backend/src/modules/retrieval/services/retrievalPipelineService.ts`

**Checkpoint**: Unsupported questions now refuse safely with the existing chat contract.

---

## Phase 4: User Story 2 - Preserve Answerability For Grounded Questions (Priority: P2)

**Goal**: Default-setting accounts still retrieve enough strong context for document-backed answers

**Independent Test**: Ask a document-backed question under default retrieval settings and verify that chat still returns a grounded answer with citations.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T007 [P] [US2] Add default-settings coverage for the higher candidate count in `/tmp/radioso-strict-grounding/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [ ] T008 [P] [US2] Add document-backed answerability coverage in `/tmp/radioso-strict-grounding/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 2

- [ ] T009 [US2] Raise the default retrieval candidate count modestly in `/tmp/radioso-strict-grounding/backend/src/modules/settings/domain/retrievalSettings.ts`
- [ ] T010 [US2] Keep final context selection behavior compatible with the stricter threshold policy in `/tmp/radioso-strict-grounding/backend/src/modules/retrieval/services/promptContextSelectorService.ts` or `/tmp/radioso-strict-grounding/backend/src/modules/retrieval/services/retrievalPipelineService.ts`

**Checkpoint**: Document-backed questions remain answerable without lowering the threshold floor.

---

## Phase 5: User Story 3 - Keep Account Settings Predictable (Priority: P3)

**Goal**: Stored retrieval settings remain authoritative while new defaults apply only where no record exists

**Independent Test**: Compare an account with stored retrieval settings against a default-setting account and verify that only the latter sees the new default candidate count.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T011 [P] [US3] Add settings-preservation coverage in `/tmp/radioso-strict-grounding/backend/tests/integration/document-settings.integration.test.ts` or `/tmp/radioso-strict-grounding/backend/tests/unit/retrieval-settings-and-chunking.test.ts`

### Implementation for User Story 3

- [ ] T012 [US3] Verify retrieval settings creation and preservation behavior in `/tmp/radioso-strict-grounding/backend/src/modules/settings/services/retrievalSettingsService.ts`

**Checkpoint**: Existing stored settings remain unchanged while defaults apply only to new records.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and artifact updates across the feature

- [ ] T013 [P] Run targeted backend test suites for `/tmp/radioso-strict-grounding/backend/tests/unit/edge-cases.test.ts`, `/tmp/radioso-strict-grounding/backend/tests/unit/retrieval-settings-and-chunking.test.ts`, `/tmp/radioso-strict-grounding/backend/tests/contract/chat.contract.test.ts`, and `/tmp/radioso-strict-grounding/backend/tests/integration/chat.integration.test.ts`
- [ ] T014 [P] Review `/tmp/radioso-strict-grounding/specs/004-strict-grounding/quickstart.md` against the final implementation and update if needed

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1**: Starts immediately
- **Phase 2**: Depends on Phase 1
- **Phase 3**: Depends on Phase 2
- **Phase 4**: Depends on Phase 3 because the stricter threshold policy defines the retrieval baseline
- **Phase 5**: Depends on Phase 4 because default behavior should be validated after the core retrieval change lands
- **Phase 6**: Depends on all prior phases

### Within Each User Story

- Tests must be written and observed failing before implementation tasks begin.
- Retrieval policy remains in retrieval services or retrieval settings modules, not in HTTP routes.
- Chat orchestration changes must remain minimal and must not absorb vector-search policy.

### Parallel Opportunities

- T003 and T004 can run in parallel.
- T007 and T008 can run in parallel.
- T013 and T014 can run in parallel after implementation completes.

## Implementation Strategy

### MVP First

1. Complete Phases 1 and 2.
2. Complete User Story 1 and validate the out-of-corpus refusal regression.
3. Stop and verify that the chat contract is unchanged before expanding the scope.

### Incremental Delivery

1. Land the hard-threshold safeguard.
2. Restore answerability for default-setting accounts through a modestly higher candidate count.
3. Confirm stored account settings remain stable.

## Notes

- The preferred implementation path is to remove threshold fallback entirely rather than replace it with a weaker floor.
- No endpoint, schema, or UI changes are planned for this feature.
