# Tasks: Selectable Chunking Strategies

**Input**: Design documents from `/specs/007-chunking-strategy-selection/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before implementation. Frontend verification follows the approved spec and quickstart.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the feature artifacts and shared structured-document test inputs

- [x] T001 Review `/tmp/hivec-chunking-strategy-selection/specs/007-chunking-strategy-selection/spec.md` and `/tmp/hivec-chunking-strategy-selection/specs/007-chunking-strategy-selection/plan.md` against `/Users/dm/code/hivec/backend/src/modules` and `/Users/dm/code/hivec/frontend/components/dashboard`
- [x] T002 [P] Add representative structured-document fixtures for headings, paragraphs, bullets, numbered steps, tables, code fences, and FAQ pairs under `/Users/dm/code/hivec/backend/tests/fixtures/chunking/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared settings and chunking seams before story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Write failing shared retrieval-settings and chunking-default tests in `/Users/dm/code/hivec/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [x] T004 [P] Add `chunking_strategy` schema support in `/Users/dm/code/hivec/backend/src/db/migrations/002_chunking_strategy.sql`
- [x] T005 [P] Persist `chunkingStrategy` in `/Users/dm/code/hivec/backend/src/db/repositories/retrievalSettingsRepository.ts` and `/Users/dm/code/hivec/backend/tests/support/fakes.ts`
- [x] T006 [P] Extend retrieval-settings defaults and validation for `chunkingStrategy` in `/Users/dm/code/hivec/backend/src/modules/settings/domain/retrievalSettings.ts` and `/Users/dm/code/hivec/backend/src/modules/settings/services/retrievalSettingsService.ts`
- [x] T007 Extract the shared chunking strategy interface, registry, and fixed-window strategy into `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/chunkingStrategy.ts`, `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.ts`, and `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.ts`
- [x] T008 Wire shared chunking-strategy dependencies in `/Users/dm/code/hivec/backend/src/app/server/dependencies.ts`, `/Users/dm/code/hivec/backend/src/app/server/types.ts`, and `/Users/dm/code/hivec/backend/tests/support/testApp.ts`

**Checkpoint**: Shared settings and chunking seams are ready for story implementation

---

## Phase 3: User Story 1 - Choose chunking strategy in Settings (Priority: P1) 🎯 MVP

**Goal**: Let an operator choose and persist the active chunking strategy from the existing Settings screen

**Independent Test**: Load retrieval settings, save a new chunking strategy, reload settings, and verify the same strategy is returned for that account

### Tests for User Story 1

- [x] T009 [P] [US1] Write failing settings contract coverage for `chunkingStrategy` in `/Users/dm/code/hivec/backend/tests/contract/settings.contract.test.ts`
- [x] T010 [P] [US1] Write failing settings round-trip integration coverage in `/Users/dm/code/hivec/backend/tests/integration/document-settings.integration.test.ts`

### Implementation for User Story 1

- [x] T011 [US1] Accept and return `chunkingStrategy` in `/Users/dm/code/hivec/backend/src/app/http/routes/settingsRoutes.ts`
- [x] T012 [US1] Extend frontend retrieval-settings types and request payloads for `chunkingStrategy` in `/Users/dm/code/hivec/frontend/lib/api.ts`
- [x] T013 [US1] Add the chunking strategy selector to `/Users/dm/code/hivec/frontend/components/dashboard/settings-view.tsx`
- [x] T014 [US1] Add plain-language option descriptions and save-flow copy in `/Users/dm/code/hivec/frontend/components/dashboard/settings-view.tsx`
- [x] T015 [US1] Sync the settings contract in `/Users/dm/code/hivec/backend/openapi.yaml` and `/tmp/hivec-chunking-strategy-selection/specs/007-chunking-strategy-selection/contracts/chunking-strategy-settings.openapi.yaml`

**Checkpoint**: User Story 1 is functional and independently testable

---

## Phase 4: User Story 2 - Use structure-aware chunking for new ingests (Priority: P2)

**Goal**: Apply a structure-aware chunking strategy to newly ingested or updated documents while preserving fixed-window as the default

**Independent Test**: Select `structured_semantic`, ingest a representative structured document, and verify persisted chunks follow structural boundaries, source order, and size bounds

### Tests for User Story 2

- [x] T016 [P] [US2] Write failing unit coverage for deterministic block parsing and bounded oversize splitting in `/Users/dm/code/hivec/backend/tests/unit/structured-chunking.test.ts`
- [x] T017 [P] [US2] Write failing unit coverage for ingest-time strategy resolution in `/Users/dm/code/hivec/backend/tests/unit/document-ingestion.test.ts`
- [x] T018 [P] [US2] Write failing integration coverage for structured chunk persistence in `/Users/dm/code/hivec/backend/tests/integration/document-chunking.integration.test.ts`

### Implementation for User Story 2

- [x] T019 [US2] Implement deterministic structural block parsing in `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/structuredBlockParser.ts`
- [x] T020 [US2] Implement bounded adjacent merge planning in `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/blockMergePlanner.ts`
- [x] T021 [US2] Implement the `structured_semantic` strategy in `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.ts`
- [x] T022 [US2] Add any narrow chunking-similarity adapter needed around embeddings in `/Users/dm/code/hivec/backend/src/modules/retrieval/services/embeddingService.ts` and `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.ts`
- [x] T023 [US2] Resolve the active chunking strategy during document create and update flows in `/Users/dm/code/hivec/backend/src/modules/documents/services/documentIngestionService.ts`
- [x] T024 [US2] Preserve fixed-window as the default strategy in `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.ts` and `/Users/dm/code/hivec/backend/src/modules/settings/domain/retrievalSettings.ts`

**Checkpoint**: User Stories 1 and 2 are independently functional

---

## Phase 5: User Story 3 - Keep strategy changes predictable (Priority: P3)

**Goal**: Make strategy changes apply only to future ingests or updates and keep structured chunking safe when semantic similarity is unavailable

**Independent Test**: Ingest a document under one strategy, change the setting, verify existing stored chunks do not change, then update the document and verify the new strategy applies; also verify structured chunking falls back to structure-only behavior when semantic similarity is unavailable

### Tests for User Story 3

- [x] T025 [P] [US3] Write failing unit coverage for structure-only fallback when semantic similarity is unavailable in `/Users/dm/code/hivec/backend/tests/unit/structured-chunking.test.ts`
- [x] T026 [P] [US3] Write failing integration coverage that strategy changes do not rewrite existing chunk sets until document update in `/Users/dm/code/hivec/backend/tests/integration/document-chunking.integration.test.ts`
- [x] T027 [P] [US3] Write failing integration coverage that document updates reapply the active strategy in `/Users/dm/code/hivec/backend/tests/integration/document-chunking.integration.test.ts`

### Implementation for User Story 3

- [x] T028 [US3] Implement deterministic structure-only fallback behavior in `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.ts` and `/Users/dm/code/hivec/backend/src/modules/retrieval/domain/chunking/blockMergePlanner.ts`
- [x] T029 [US3] Ensure document updates re-run the active chunking strategy without silent background re-chunking in `/Users/dm/code/hivec/backend/src/modules/documents/services/documentIngestionService.ts`
- [x] T030 [US3] Add future-ingest-only explanatory copy to `/Users/dm/code/hivec/frontend/components/dashboard/settings-view.tsx`

**Checkpoint**: All user stories are independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final consistency, docs, and verification across stories

- [x] T031 [P] Refresh feature docs in `/tmp/hivec-chunking-strategy-selection/specs/007-chunking-strategy-selection/quickstart.md` and `/tmp/hivec-chunking-strategy-selection/specs/007-chunking-strategy-selection/contracts/chunking-strategy-settings.openapi.yaml` if implementation details drift
- [x] T032 Run backend test suites for affected coverage in `/Users/dm/code/hivec/backend/tests/`
- [x] T033 Run frontend lint and verify the selector flow in `/Users/dm/code/hivec/frontend/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and uses the shared chunking seam plus the persisted settings field
- **User Story 3 (Phase 5)**: Depends on User Story 2 because fallback and update behavior build on the structured strategy path
- **Polish (Phase 6)**: Depends on all completed story work

### User Story Dependencies

- **US1**: Independent after Foundational phase
- **US2**: Depends on the shared chunking seam and persisted `chunkingStrategy`, but remains independently testable once those foundations land
- **US3**: Depends on the structured strategy path from US2 and remains independently testable through fallback and update-behavior checks

### Within Each User Story

- Backend tests must be written and fail before implementation
- Persistence and validation land before route and UI wiring
- Focused chunking modules land before ingestion orchestration expands
- Existing responsibility-limited files must stay orchestration-only or transport-only
- Frontend changes must not introduce advanced structured-chunking controls

### Parallel Opportunities

- T004, T005, and T006 can run in parallel after T003 exists
- T009 and T010 can run in parallel
- T016, T017, and T018 can run in parallel
- T025, T026, and T027 can run in parallel

---

## Parallel Example: User Story 1

```bash
Task: "Write failing settings contract coverage for chunkingStrategy in /Users/dm/code/hivec/backend/tests/contract/settings.contract.test.ts"
Task: "Write failing settings round-trip integration coverage in /Users/dm/code/hivec/backend/tests/integration/document-settings.integration.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Write failing unit coverage for deterministic block parsing and bounded oversize splitting in /Users/dm/code/hivec/backend/tests/unit/structured-chunking.test.ts"
Task: "Write failing unit coverage for ingest-time strategy resolution in /Users/dm/code/hivec/backend/tests/unit/document-ingestion.test.ts"
Task: "Write failing integration coverage for structured chunk persistence in /Users/dm/code/hivec/backend/tests/integration/document-chunking.integration.test.ts"
```

## Parallel Example: User Story 3

```bash
Task: "Write failing unit coverage for structure-only fallback when semantic similarity is unavailable in /Users/dm/code/hivec/backend/tests/unit/structured-chunking.test.ts"
Task: "Write failing integration coverage that strategy changes do not rewrite existing chunk sets until document update in /Users/dm/code/hivec/backend/tests/integration/document-chunking.integration.test.ts"
Task: "Write failing integration coverage that document updates reapply the active strategy in /Users/dm/code/hivec/backend/tests/integration/document-chunking.integration.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate that strategy selection persists and round-trips through Settings

### Incremental Delivery

1. Add account-scoped strategy selection in Settings
2. Add the structure-aware chunking strategy for new ingests and updates
3. Add predictable fallback and future-ingest-only behavior
4. Run final backend and frontend verification

### Parallel Team Strategy

1. One engineer owns retrieval-settings persistence and transport changes
2. One engineer owns chunking domain extraction and structured strategy behavior
3. One engineer owns frontend settings UI once the settings contract is stable

## Notes

- Total tasks: 33
- User story task counts: US1 = 7, US2 = 9, US3 = 6
- Suggested MVP scope: Phase 3 / User Story 1
- All tasks follow the required checklist format with task id, labels, and file paths
