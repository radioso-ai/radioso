# Tasks: Split Semantic And Lexical Query Rewrite

**Input**: Design documents from `/specs/032-split-rewrite-queries/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and must be written before implementation changes. Frontend verification follows the retrieval settings and retrieval trace scenarios in `quickstart.md`.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the feature documentation and execution scaffolding

- [ ] T001 Confirm planned feature artifacts are present in /Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared contracts and domain seams required before any user story work

**⚠️ CRITICAL**: No user story implementation should begin until this phase is complete

- [ ] T002 Add failing retrieval-settings validation coverage for split rewrite instruction defaults and preservation in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/retrieval-settings-and-chunking.test.ts
- [ ] T003 [P] Add failing retrieval settings contract coverage for semanticRewriteInstructions and lexicalRewriteInstructions in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/contract/settings.contract.test.ts
- [ ] T004 [P] Add failing frontend API typing expectations for split rewrite settings in /Users/dm/conductor/workspaces/radioso/sacramento/frontend/lib/api.ts
- [ ] T005 Implement split rewrite settings defaults and validation in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/settings/domain/retrievalSettings.ts
- [ ] T006 Implement split rewrite settings persistence in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/db/repositories/retrievalSettingsRepository.ts
- [ ] T007 Update retrieval settings route schema and preservation logic in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/app/http/routes/settingsRoutes.ts
- [ ] T008 Update code-first retrieval settings schemas in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/app/http/openapi/document.ts
- [ ] T009 Regenerate generated OpenAPI outputs in /Users/dm/conductor/workspaces/radioso/sacramento/backend/openapi.yaml and /Users/dm/conductor/workspaces/radioso/sacramento/backend/openapi.json
- [ ] T010 Update frontend retrieval settings types in /Users/dm/conductor/workspaces/radioso/sacramento/frontend/lib/api.ts

**Checkpoint**: Retrieval settings contracts and persistence support split rewrite instructions

---

## Phase 3: User Story 1 - Retrieve Better With Different Query Shapes (Priority: P1) 🎯 MVP

**Goal**: Produce distinct semantic and lexical retrieval queries when query rewrite guidance calls for different query shapes

**Independent Test**: Enable query rewrite, configure distinct instructions, run a notation-sensitive query, and verify semantic and lexical queries can differ while retrieval still succeeds with safe fallback behavior

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T011 [P] [US1] Add failing split-query rewrite unit coverage in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/retrieval-pipeline-stages.test.ts
- [ ] T012 [P] [US1] Add failing rewrite fallback edge-case coverage in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/edge-cases.test.ts
- [ ] T013 [P] [US1] Add failing integration coverage for workspace-scoped split rewrite execution in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/integration/chat.integration.test.ts

### Implementation for User Story 1

- [ ] T014 [US1] Extend rewrite domain contracts for semantic and lexical query outputs in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts
- [ ] T015 [US1] Implement split rewrite prompting and normalization in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/retrieval/services/queryRewriteService.ts
- [ ] T016 [US1] Update query interpretation to select active semantic and lexical queries independently in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/retrieval/services/queryInterpretationStage.ts
- [ ] T017 [US1] Preserve downstream lexical and semantic query consumption in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/retrieval/services/candidateRetrievalStage.ts

**Checkpoint**: User Story 1 works independently with one semantic query and one lexical query per request

---

## Phase 4: User Story 2 - Configure Rewrite Behavior Per Workspace (Priority: P2)

**Goal**: Let workspace admins configure semantic and lexical rewrite instructions through retrieval settings API and UI

**Independent Test**: Save distinct semantic and lexical rewrite instructions in retrieval settings, reload them, and confirm only that workspace uses the saved values

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T018 [P] [US2] Add failing retrieval settings integration coverage for split rewrite fields in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/integration/document-settings.integration.test.ts

### Implementation for User Story 2

- [ ] T019 [US2] Add split rewrite controls to the retrieval settings form in /Users/dm/conductor/workspaces/radioso/sacramento/frontend/components/dashboard/settings/retrieval-settings-panel.tsx
- [ ] T020 [US2] Keep retrieval settings save and reload behavior aligned with split rewrite fields in /Users/dm/conductor/workspaces/radioso/sacramento/frontend/lib/api.ts

**Checkpoint**: User Story 2 works independently through settings API and UI

---

## Phase 5: User Story 3 - Inspect Rewrite Outputs In Retrieval Diagnostics (Priority: P3)

**Goal**: Show original, semantic, and lexical queries plus fallback details in retrieval diagnostics and trace views

**Independent Test**: Execute retrieval with rewrite applied and with fallback, then confirm the trace/details view exposes the original query, semantic query, lexical query, and fallback or rejection reason

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T021 [P] [US3] Add failing retrieval info presentation coverage for split-query fields in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/hybrid-retrieval-info.test.ts
- [ ] T022 [P] [US3] Add failing trace assembly coverage for split-query diagnostics in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/unit/retrieval-pipeline-stages.test.ts

### Implementation for User Story 3

- [ ] T023 [US3] Update retrieval diagnostics and info presentation for split-query outputs in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/retrieval/services/retrievalInfoPresenter.ts
- [ ] T024 [US3] Update retrieval trace assembly for original query and fallback visibility in /Users/dm/conductor/workspaces/radioso/sacramento/backend/src/modules/retrieval/services/retrievalTraceAssembler.ts
- [ ] T025 [US3] Update retrieval trace detail presentation in /Users/dm/conductor/workspaces/radioso/sacramento/frontend/components/dashboard/chat-retrieval-trace-detail.tsx

**Checkpoint**: All user stories are independently functional and observable

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and cleanup across stories

- [ ] T026 [P] Run targeted backend tests for split rewrite settings, pipeline, integration, and contract coverage in /Users/dm/conductor/workspaces/radioso/sacramento/backend/tests/
- [ ] T027 [P] Run frontend and OpenAPI verification for retrieval settings and trace surfaces in /Users/dm/conductor/workspaces/radioso/sacramento/frontend/ and /Users/dm/conductor/workspaces/radioso/sacramento/backend/
- [ ] T028 Run quickstart validation against /Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and consumes the settings contract from Phase 2
- **User Story 3 (Phase 5)**: Depends on User Story 1 because diagnostics must reflect actual split-query execution
- **Polish (Phase 6)**: Depends on all implemented user stories

### User Story Dependencies

- **US1**: Starts after Foundational; no dependency on other user stories
- **US2**: Starts after Foundational; independent of US1 behavior but depends on the same settings fields
- **US3**: Depends on US1 split-query runtime behavior and the settings fields from Foundational

### Within Each User Story

- Backend tests must be written and fail before implementation
- Domain contracts before orchestration changes
- Orchestration before UI wiring that depends on the new behavior
- Code-first OpenAPI updates before generated OpenAPI refresh

### Parallel Opportunities

- T003 and T004 can run in parallel
- T011, T012, and T013 can run in parallel
- T021 and T022 can run in parallel
- Final verification tasks T026 and T027 can run in parallel

---

## Parallel Example: User Story 1

```bash
Task: "Add failing split-query rewrite unit coverage in backend/tests/unit/retrieval-pipeline-stages.test.ts"
Task: "Add failing rewrite fallback edge-case coverage in backend/tests/unit/edge-cases.test.ts"
Task: "Add failing integration coverage for workspace-scoped split rewrite execution in backend/tests/integration/chat.integration.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 and Phase 2
2. Complete User Story 1
3. Validate split semantic and lexical query execution independently

### Incremental Delivery

1. Land split settings contracts and persistence
2. Add split semantic and lexical rewrite execution
3. Add settings UI controls
4. Add diagnostics and trace visibility

### Parallel Team Strategy

1. Complete foundational settings/schema work together
2. Split runtime rewrite work, UI work, and diagnostics work once the shared contracts are stable

## Notes

- Backend TDD is mandatory for this feature
- Keep edits scoped away from unrelated dirty files already present in the worktree
- Preserve current retrieval pipeline entrypoints and fallback behavior while extending the internal rewrite contract
