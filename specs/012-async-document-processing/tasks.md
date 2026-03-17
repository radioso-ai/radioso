# Tasks: Async Document Processing

**Input**: Design documents from `/specs/012-async-document-processing/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/document-processing.openapi.yaml`

**Tests**: Backend tests are required and must be written before implementation tasks for each backend slice. Frontend changes will be validated with linting.

**Organization**: Tasks are grouped by user story to preserve independent delivery and testing.

## Phase 1: Setup

**Purpose**: Establish design artifacts and migration scaffolding for async processing.

- [x] T001 Create planning artifacts in `specs/012-async-document-processing/plan.md`, `specs/012-async-document-processing/research.md`, `specs/012-async-document-processing/data-model.md`, `specs/012-async-document-processing/quickstart.md`, and `specs/012-async-document-processing/contracts/document-processing.openapi.yaml`
- [x] T002 Define the new durable processing schema in `backend/src/db/migrations/004_async_document_processing.sql`

---

## Phase 2: Foundational

**Purpose**: Introduce the core seams for durable background processing before user-story behavior lands.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T003 Write unit coverage for revision-aware document orchestration and processing-job repository seams in `backend/tests/unit/document-ingestion.test.ts` and related support fakes
- [x] T004 Implement revision-aware document persistence updates in `backend/src/modules/documents/services/documentIngestionService.ts` and `backend/src/db/repositories/documentRepository.ts`
- [x] T005 [P] Implement durable processing-job persistence in `backend/src/db/repositories/documentProcessingJobRepository.ts`
- [x] T006 [P] Extract background processing logic into `backend/src/modules/documents/services/documentProcessingService.ts`
- [x] T007 Implement the worker coordinator in `backend/src/modules/documents/services/documentProcessingWorker.ts` and wire it in `backend/src/app/server/dependencies.ts` and `backend/src/index.ts`
- [x] T008 Update in-memory test doubles in `backend/tests/support/fakes.ts` and `backend/tests/support/testApp.ts` for revision and job behavior

**Checkpoint**: Request-time orchestration, processing domain logic, worker startup, and repository seams are available.

---

## Phase 3: User Story 1 - Submit Documents Without Blocking (Priority: P1) 🎯 MVP

**Goal**: Accept create and update requests quickly while durable background processing completes later.

**Independent Test**: Create or update a document and verify the API returns an accepted non-final state immediately while the worker can later drive the document to ready.

### Tests for User Story 1

- [x] T009 [P] [US1] Update contract coverage for accepted async create and update responses in `backend/tests/contract/document.contract.test.ts`
- [x] T010 [P] [US1] Add integration coverage for async acceptance and worker completion in `backend/tests/integration/document-settings.integration.test.ts`
- [x] T011 [P] [US1] Add persistence coverage for durable jobs and ready publication in `backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 1

- [x] T012 [US1] Update document routes for accepted async create and update responses in `backend/src/app/http/routes/documentRoutes.ts`
- [x] T013 [US1] Update document API response types in `frontend/lib/api.ts`
- [x] T014 [US1] Adjust frontend document creation and editing flows for non-blocking acceptance in `frontend/components/dashboard/documents-view.tsx`
- [x] T015 [US1] Add job-safe chunk replacement and any needed bulk write improvements in `backend/src/db/repositories/chunkRepository.ts`

**Checkpoint**: Operators can create and update documents without waiting for full processing, and the worker can complete the accepted work.

---

## Phase 4: User Story 2 - Track Processing Progress and Failures (Priority: P2)

**Goal**: Make queued, processing, ready, and failed states visible, and provide a clear retry path for terminal failures.

**Independent Test**: Create a document and observe status transitions in the document list; force a failure and verify the UI surfaces failure and a retry action.

### Tests for User Story 2

- [x] T016 [P] [US2] Add unit coverage for status transitions and retry handling in `backend/tests/unit/document-ingestion.test.ts`
- [x] T017 [P] [US2] Add contract coverage for document detail/list status fields and reprocess acceptance in `backend/tests/contract/document.contract.test.ts`

### Implementation for User Story 2

- [x] T018 [US2] Add document reprocess orchestration and route handling in `backend/src/modules/documents/services/documentIngestionService.ts` and `backend/src/app/http/routes/documentRoutes.ts`
- [x] T019 [US2] Update frontend document status rendering and polling in `frontend/components/dashboard/document-status.tsx` and `frontend/components/dashboard/documents-view.tsx`
- [x] T020 [US2] Record accepted, completed, retried, and failed outcomes through existing audit paths in backend document services

**Checkpoint**: Operators can see accurate document status and retry failed documents from the UI.

---

## Phase 5: User Story 3 - Protect Latest Content From Stale Work (Priority: P3)

**Goal**: Ensure out-of-order completion never publishes superseded content.

**Independent Test**: Update the same document multiple times quickly and confirm only the latest revision becomes ready and searchable.

### Tests for User Story 3

- [x] T021 [P] [US3] Add unit coverage for stale-job skipping and deleted-document handling in `backend/tests/unit/document-ingestion.test.ts`
- [x] T022 [P] [US3] Extend async persistence coverage for ready-only retrieval publication in `backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 3

- [x] T023 [US3] Add revision checks to document publication and job completion in `backend/src/modules/documents/services/documentProcessingService.ts`
- [x] T024 [US3] Ensure queued or stale revisions cannot be retrieved by updating `backend/src/modules/retrieval/infra/vectorSearch.ts`, `backend/src/modules/retrieval/infra/lexicalSearch.ts`, and related processing paths

**Checkpoint**: Stale or deleted revisions cannot become the active ready result.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, cleanup, and artifact sync.

- [x] T025 Update completed task state and implementation notes in `specs/012-async-document-processing/tasks.md`
- [x] T026 Run backend and frontend validation for the feature and capture outcomes in the delivery summary
- [x] T027 Review the final diff for modularity drift, unused seams, and scope fit against `specs/012-async-document-processing/spec.md`

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 must complete before phase 2.
- Phase 2 blocks all user-story implementation.
- Phase 3 is the MVP and must land before phases 4 and 5.
- Phase 4 depends on the async command and worker foundation from phase 3.
- Phase 5 depends on the revision and worker foundation from phase 3.
- Phase 6 depends on all desired user stories being complete.

### User Story Dependencies

- **US1**: Depends on foundational async orchestration and worker seams.
- **US2**: Depends on US1 request acceptance and worker-driven status changes.
- **US3**: Depends on US1 durable job and revision primitives.

### Parallel Opportunities

- T005 and T006 can proceed in parallel once the foundational test shape is set.
- Backend contract and integration tests within a user story can be authored in parallel.
- Frontend API and UI updates for a story can proceed after the corresponding backend contract is settled.

## Implementation Strategy

### MVP First

1. Establish migration and core seams.
2. Deliver US1 non-blocking create and update acceptance.
3. Validate worker completion and retrieval publication.

### Incremental Delivery

1. Add status visibility and retry handling for US2.
2. Add stale-revision protection and delete safety for US3.
3. Finish with validation and review cleanup.
