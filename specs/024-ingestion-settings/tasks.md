# Tasks: Ingestion Settings Controls

**Input**: Design documents from `/specs/024-ingestion-settings/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED. New or updated backend tests must fail before implementation changes land. Frontend validation follows the feature quickstart and existing UI test patterns if added during implementation.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the feature artifacts, current settings seams, and target files before implementation.

- [X] T001 Verify the active feature artifacts in `/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/` and target backend/frontend files in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/routes/settingsRoutes.ts`, `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/openapi/document.ts`, `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/components/dashboard/settings-view.tsx`, and `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/lib/api.ts`
- [X] T002 Review and preserve current settings and document-processing dependency wiring in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/server/dependencies.ts` and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/support/testApp.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the ingestion-settings architecture seam before changing UI or behavior.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Add failing backend validation coverage for ingestion settings defaults and invalid size relationships in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/unit/ingestion-settings.test.ts`
- [X] T004 [P] Add failing contract coverage for the retrieval/ingestion settings API split in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/contract/settings.contract.test.ts`
- [X] T005 [P] Add failing integration coverage for ingestion settings persistence and workspace-level reprocess initiation in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/integration/document-settings.integration.test.ts`
- [X] T006 [P] Create the ingestion settings domain model, defaults, and validation in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/settings/domain/ingestionSettings.ts`
- [X] T007 [P] Create the ingestion settings repository in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/db/repositories/ingestionSettingsRepository.ts`
- [X] T008 [P] Create the ingestion settings service in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/settings/services/ingestionSettingsService.ts`
- [X] T009 Add the additive ingestion settings migration and backfill logic in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/db/migrations/009_ingestion_settings.sql`
- [X] T010 Reduce retrieval settings to retrieval-only concerns in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/settings/domain/retrievalSettings.ts` and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/db/repositories/retrievalSettingsRepository.ts`
- [X] T011 Wire ingestion settings dependencies in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/server/dependencies.ts` and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/support/testApp.ts`

**Checkpoint**: Ingestion settings exist as a separate backend seam with failing tests in place and wiring ready for story implementation.

---

## Phase 3: User Story 1 - Tune Ingestion In One Place (Priority: P1) 🎯 MVP

**Goal**: Add a dedicated Ingestion tab after General, move chunking controls out of Retrieval, and persist ingestion settings through a dedicated API.

**Independent Test**: Open Settings, confirm the tab order is `General`, `Ingestion`, `Retrieval`, `Chat Connectors`, save ingestion settings in the new tab, reload, and verify the saved values return through the ingestion settings API while Retrieval no longer shows chunking controls.

### Tests for User Story 1 (REQUIRED for backend)

- [X] T012 [P] [US1] Extend retrieval-settings contract assertions for chunking removal in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/contract/settings.contract.test.ts`
- [X] T013 [P] [US1] Add ingestion-settings contract assertions for `GET`/`PUT /api/v1/settings/ingestion` in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/contract/settings.contract.test.ts`
- [X] T014 [P] [US1] Add integration coverage for ingestion settings round-tripping per workspace in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/integration/document-settings.integration.test.ts`

### Implementation for User Story 1

- [X] T015 [US1] Add ingestion settings request schemas and routes in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/routes/settingsRoutes.ts`
- [X] T016 [US1] Register ingestion settings schemas and endpoints in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/openapi/document.ts`
- [X] T017 [US1] Update API client types and methods for retrieval/ingestion settings split in `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/lib/api.ts`
- [X] T018 [US1] Rework the Settings tab order and add an Ingestion panel shell in `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/components/dashboard/settings-view.tsx`
- [X] T019 [US1] Move chunking strategy UI from Retrieval to Ingestion and remove chunking controls from the Retrieval panel in `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/components/dashboard/settings-view.tsx`
- [X] T020 [US1] Regenerate generated OpenAPI outputs in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/openapi.json`

**Checkpoint**: User Story 1 is complete when ingestion settings live in their own tab and API surface, and retrieval settings no longer own chunking controls.

---

## Phase 4: User Story 2 - Tune Chunking Behavior For Each Strategy (Priority: P2)

**Goal**: Expose meaningful chunk-boundary tuning controls for fixed-window and structured-semantic chunking and apply them during document processing.

**Independent Test**: Save different ingestion tuning values for each strategy, ingest or update representative documents, and verify the resulting chunk sets reflect the saved chunk sizes and overlap.

### Tests for User Story 2 (REQUIRED for backend)

- [X] T021 [P] [US2] Add unit coverage for fixed-window and structured-semantic tuning behavior in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [X] T022 [P] [US2] Add integration coverage for ingest/update using saved ingestion settings in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/integration/document-settings.integration.test.ts`
- [X] T023 [P] [US2] Add contract assertions for ingestion tuning fields and validation failures in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/contract/settings.contract.test.ts`

### Implementation for User Story 2

- [X] T024 [P] [US2] Add configurable fixed-window chunk size and overlap support in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/retrieval/domain/chunking/fixedWindowChunkingStrategy.ts`
- [X] T025 [P] [US2] Add configurable structured min/max chunk size support in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/retrieval/domain/chunking/blockMergePlanner.ts` and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/retrieval/domain/chunking/structuredSemanticChunkingStrategy.ts`
- [X] T026 [US2] Update chunking strategy interfaces and registry wiring to consume workspace ingestion settings in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/retrieval/domain/chunking/chunkingStrategy.ts`, `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/retrieval/domain/chunking/chunkingStrategyRegistry.ts`, and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/server/dependencies.ts`
- [X] T027 [US2] Switch document processing to read ingestion settings and pass strategy-specific tuning into chunking in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/documents/services/documentProcessingService.ts`
- [X] T028 [US2] Add fixed-window and structured tuning controls, descriptions, and advanced grouping in `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/components/dashboard/settings-view.tsx`

**Checkpoint**: User Story 2 is complete when saved ingestion tuning values produce measurable chunking changes for new ingests and updates.

---

## Phase 5: User Story 3 - Understand And Apply Setting Changes Safely (Priority: P3)

**Goal**: Explain when ingestion settings take effect and provide a safe workspace-level reprocess action for eligible existing documents.

**Independent Test**: Change ingestion settings in a workspace with existing documents, verify the UI explains that existing chunks are unchanged, start workspace reprocess, and confirm eligible documents are queued while already queued or processing documents are skipped.

### Tests for User Story 3 (REQUIRED for backend)

- [X] T029 [P] [US3] Add unit coverage for workspace bulk reprocess eligibility and duplicate-prevention rules in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/unit/workspace-ingestion-reprocess.test.ts`
- [X] T030 [P] [US3] Add integration coverage for workspace reprocess counts and skipped in-flight documents in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/integration/document-settings.integration.test.ts`
- [X] T031 [P] [US3] Add contract coverage for `POST /api/v1/settings/ingestion/reprocess` in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/tests/contract/settings.contract.test.ts`

### Implementation for User Story 3

- [X] T032 [P] [US3] Add bulk document eligibility lookup and requeue persistence helpers in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/db/repositories/documentRepository.ts`
- [X] T033 [P] [US3] Implement workspace ingestion reprocess orchestration in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/modules/documents/services/workspaceIngestionReprocessService.ts`
- [X] T034 [US3] Add the workspace reprocess route and request handling in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/routes/settingsRoutes.ts`
- [X] T035 [US3] Register the workspace reprocess endpoint and response schema in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/src/app/http/openapi/document.ts`
- [X] T036 [US3] Add Ingestion tab guidance text and workspace reprocess action UI in `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/components/dashboard/settings-view.tsx`
- [X] T037 [US3] Add frontend API method for workspace ingestion reprocess in `/Users/dm/conductor/workspaces/radioso/edinburgh/frontend/lib/api.ts`
- [X] T038 [US3] Regenerate generated OpenAPI outputs in `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/edinburgh/backend/openapi.json`

**Checkpoint**: User Story 3 is complete when operators can safely reprocess existing documents from the Ingestion tab and understand when settings take effect.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and artifact alignment across all stories.

- [X] T039 [P] Run the quickstart validation flow from `/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/quickstart.md`
- [X] T040 Verify changed code and generated artifacts stay within `/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/spec.md` and `/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/plan.md` scope
- [X] T041 [P] Update completion markers and residual-risk notes in `/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/tasks.md`

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Starts after Foundational and delivers the MVP settings split
- **User Story 2 (Phase 4)**: Depends on User Story 1 ingestion API/UI seams being in place
- **User Story 3 (Phase 5)**: Depends on the ingestion settings split and document-processing wiring from earlier phases
- **Polish (Phase 6)**: Depends on all desired stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2 with no dependency on other stories
- **User Story 2 (P2)**: Depends on User Story 1 because the new tuning controls belong to the Ingestion API/UI introduced there
- **User Story 3 (P3)**: Depends on User Story 1 and benefits from User Story 2 wiring, but its bulk reprocess flow remains independently testable once ingestion settings exist

### Within Each User Story

- Backend tests must be written and fail before implementation tasks for that story
- New domain and service seams should land before transport/UI wiring uses them
- Code-first OpenAPI updates must precede generated OpenAPI regeneration
- Changes to `settings-view.tsx`, `settingsRoutes.ts`, and `documentRepository.ts` should stay sequential when tasks touch the same file
- Responsibility-limited files must stay orchestration-only or UI-only as defined in `plan.md`

### Parallel Opportunities

- T004-T008 can run in parallel once the initial setup review is done
- US1 contract and integration tests in T012-T014 can run in parallel
- US2 chunking strategy implementation tasks T024-T025 can run in parallel before orchestration wiring in T026-T027
- US3 backend tests T029-T031 can run in parallel
- US3 repository and service tasks T032-T033 can run in parallel before route/UI wiring

---

## Parallel Example: User Story 1

```bash
# Backend tests for the ingestion API split
Task: "T012 [US1] Extend retrieval-settings contract assertions in backend/tests/contract/settings.contract.test.ts"
Task: "T013 [US1] Add ingestion-settings contract assertions in backend/tests/contract/settings.contract.test.ts"
Task: "T014 [US1] Add integration coverage for ingestion settings round-tripping in backend/tests/integration/document-settings.integration.test.ts"

# Frontend/backend wiring that can progress on disjoint files after schemas settle
Task: "T017 [US1] Update API client types and methods in frontend/lib/api.ts"
Task: "T018 [US1] Rework the Settings tab order and add an Ingestion panel shell in frontend/components/dashboard/settings-view.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases
2. Deliver the dedicated Ingestion API and Settings tab split in User Story 1
3. Validate that Retrieval no longer owns chunking controls and that Ingestion round-trips correctly
4. Stop and demo before expanding into advanced tuning or bulk reprocess

### Incremental Delivery

1. Establish the ingestion settings backend seam and migration
2. Deliver User Story 1 as the product-visible split
3. Add User Story 2 tuning controls and chunking behavior
4. Add User Story 3 workspace reprocess orchestration
5. Finish with quickstart validation and artifact cleanup

### Parallel Team Strategy

With multiple engineers after the foundational phase:

- Engineer A: ingestion settings API, schemas, and OpenAPI updates
- Engineer B: frontend Ingestion tab and API client updates
- Engineer C: chunking strategy tuning and workspace reprocess orchestration
