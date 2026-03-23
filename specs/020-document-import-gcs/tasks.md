# Tasks: Document Import and GCS Storage

**Input**: Design documents from `/specs/020-document-import-gcs/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/document-import.openapi.yaml`, `quickstart.md`

**Tests**: Backend tests are required and must be written before implementation for each backend story slice. Frontend validation is via `eslint` plus manual quickstart checks.

**Organization**: Tasks are grouped by user story so the upload path, failure handling, and reprocess/cleanup behavior can be implemented and validated incrementally.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add package and dependency scaffolding for file-backed imports.

- [X] T001 Create `packages/document-parser/package.json`, `packages/document-parser/index.js`, and `packages/document-parser/index.d.ts`
- [X] T002 Update `backend/package.json` and `backend/package-lock.json` with `@hivec/document-parser`, object-storage, and multipart parsing dependencies
- [X] T003 [P] Add parser package entry files in `packages/document-parser/parsers/pdf.js`, `packages/document-parser/parsers/txt.js`, `packages/document-parser/parsers/docx.js`, and `packages/document-parser/parsers/xlsx.js`

**Checkpoint**: The backend can import the new local parser package with no backend-to-package reverse dependency.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the core schema and service seams that all user stories depend on.

**⚠️ CRITICAL**: No user story work begins until the document source model, storage seam, and dependency wiring exist.

- [X] T004 Create `backend/src/db/migrations/009_document_import_storage.sql` for additive document source columns
- [X] T005 Update `backend/src/modules/documents/services/documentIngestionService.ts` type ports and records for file-backed document source metadata
- [X] T006 Update `backend/src/db/repositories/documentRepository.ts` to persist and read the new document source fields
- [X] T007 Create `backend/src/modules/documents/infra/gcsDocumentStorage.ts` and storage port definitions for object save/read/delete
- [X] T008 Update `backend/src/app/config/env.ts`, `backend/.env.example`, `backend/src/app/server/types.ts`, and `backend/src/app/server/dependencies.ts` for document import storage configuration and dependency wiring
- [X] T009 Update `backend/tests/support/fakes.ts` and `backend/tests/support/testApp.ts` with in-memory document storage/parser test doubles

**Checkpoint**: The backend has explicit source-kind and storage seams with test support, but no upload behavior yet.

---

## Phase 3: User Story 1 - Import a supported document from Documents (Priority: P1) 🎯 MVP

**Goal**: Accept supported file uploads from Documents, store the original file in GCS, and process imported content through the existing retrieval pipeline.

**Independent Test**: Upload a supported file from Documents, observe a queued document in the list, allow processing to finish, and verify the document becomes retrievable in chat.

### Tests for User Story 1 (REQUIRED for backend)

- [X] T010 [US1] Extend `backend/tests/contract/document.contract.test.ts` with a multipart import acceptance test for `POST /api/v1/document/import`
- [X] T011 [P] [US1] Create `backend/tests/unit/document-import-service.test.ts` covering upload acceptance, title derivation, and object storage handoff
- [X] T012 [P] [US1] Create `backend/tests/unit/document-source-content.test.ts` covering inline-text and uploaded-file source materialization during processing

### Implementation for User Story 1

- [X] T013 [P] [US1] Implement parser package dispatch and supported-file extraction in `packages/document-parser/index.js` and `packages/document-parser/parsers/*`
- [X] T014 [US1] Create `backend/src/modules/documents/services/documentImportService.ts` for multipart upload acceptance, object storage, and queued document creation
- [X] T015 [US1] Create `backend/src/modules/documents/services/documentSourceContentService.ts` to load inline text or stored file content before chunking
- [X] T016 [US1] Update `backend/src/modules/documents/services/documentProcessingService.ts` to use `documentSourceContentService.ts` and persist extracted text for uploaded files
- [X] T017 [US1] Update `backend/src/app/http/routes/documentRoutes.ts` for `POST /import` multipart handling while preserving the existing JSON create/update routes
- [X] T018 [US1] Update `frontend/lib/api.ts` to add a document import client using `FormData` without breaking the existing JSON document APIs
- [X] T019 [US1] Update `frontend/components/dashboard/documents-view.tsx` to add a file import action and upload dialog alongside the existing manual text flow

**Checkpoint**: Supported file upload works end to end and imported content becomes retrievable after async processing.

---

## Phase 4: User Story 2 - Reject invalid or unsupported uploads safely (Priority: P2)

**Goal**: Reject invalid uploads early, surface clear failures, and keep broken imports out of the ready state.

**Independent Test**: Submit unsupported, empty, malformed, and forced-storage-failure uploads and verify clear API and UI errors with no misleading ready document.

### Tests for User Story 2 (REQUIRED for backend)

- [X] T020 [US2] Extend `backend/tests/contract/document.contract.test.ts` with unsupported, empty, and over-limit import rejection cases
- [X] T021 [P] [US2] Extend `backend/tests/unit/document-import-service.test.ts` with storage failure and validation failure cases
- [X] T022 [P] [US2] Extend `backend/tests/unit/document-source-content.test.ts` with parser/read failure cases that lead to terminal document failure

### Implementation for User Story 2

- [X] T023 [US2] Add supported-type, size-limit, and empty-file validation in `backend/src/app/http/routes/documentRoutes.ts` and `backend/src/modules/documents/services/documentImportService.ts`
- [X] T024 [US2] Update `backend/src/modules/documents/services/documentProcessingWorker.ts` and related document services to preserve user-safe failure reasons for uploaded-file processing failures
- [X] T025 [US2] Update `frontend/components/dashboard/documents-view.tsx` to show inline import validation and failure feedback for rejected or failed imports

**Checkpoint**: Invalid imports fail clearly, and uploaded-file processing failures are visible instead of ambiguous.

---

## Phase 5: User Story 3 - Reprocess imported files from the stored original (Priority: P3)

**Goal**: Reprocess uploaded documents from stored source objects and delete file-backed documents without orphaning storage.

**Independent Test**: Reprocess an uploaded document without re-uploading it, then delete it and verify the stored object is removed too.

### Tests for User Story 3 (REQUIRED for backend)

- [X] T026 [US3] Extend `backend/tests/unit/document-ingestion.test.ts` with uploaded-file reprocess coverage that re-reads the stored original
- [X] T027 [P] [US3] Extend `backend/tests/unit/document-deletion.test.ts` with stored-object deletion success and failure coverage
- [X] T028 [P] [US3] Extend `backend/tests/integration/persistence.integration.test.ts` with imported-document persistence, reprocess, and delete lifecycle coverage

### Implementation for User Story 3

- [X] T029 [US3] Update `backend/src/modules/documents/services/documentIngestionService.ts` and `backend/src/modules/documents/services/documentSourceContentService.ts` so reprocess for uploaded files uses stored object metadata as the source of truth
- [X] T030 [US3] Update `backend/src/modules/documents/services/documentDeletionService.ts` and `backend/src/modules/documents/infra/gcsDocumentStorage.ts` so file-backed deletes remove the stored object before deleting the document row
- [X] T031 [US3] Update `frontend/components/dashboard/documents-view.tsx` to keep retry/delete behavior correct for imported documents and show source metadata in the list

**Checkpoint**: Uploaded documents can be retried and deleted safely without re-uploading or leaving orphaned objects behind.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final contract, documentation, and validation updates spanning all stories.

- [X] T032 [P] Update `backend/openapi.yaml` and `specs/020-document-import-gcs/contracts/document-import.openapi.yaml` to document the new import endpoint and source metadata fields
- [X] T033 [P] Run targeted backend validation in `backend/tests/contract/document.contract.test.ts`, `backend/tests/unit/document-import-service.test.ts`, `backend/tests/unit/document-source-content.test.ts`, `backend/tests/unit/document-ingestion.test.ts`, `backend/tests/unit/document-deletion.test.ts`, and `backend/tests/integration/persistence.integration.test.ts`
- [X] T034 [P] Run frontend validation with `frontend/package.json` lint script and resolve any import-flow lint issues
- [ ] T035 Validate the local credential and supported-upload flow described in `specs/020-document-import-gcs/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately
- **Foundational (Phase 2)**: Depends on Setup; blocks all story work
- **User Story 1 (Phase 3)**: Depends on Foundational
- **User Story 2 (Phase 4)**: Depends on US1 because rejection/error handling builds on the import path
- **User Story 3 (Phase 5)**: Depends on US1 and the source metadata/storage seam from Phase 2
- **Polish (Phase 6)**: Depends on all implemented stories

### User Story Dependencies

- **US1**: MVP; no dependency on other stories after Foundational
- **US2**: Extends US1 failure paths and UI feedback
- **US3**: Extends US1 lifecycle behavior for reprocess and delete

### Within Each User Story

- Backend tests must be written and fail before implementation tasks
- Parser package implementation lands before backend orchestration uses it
- Storage and source-content seams land before route/UI wiring depends on them
- UI client updates land before the final Documents UI integration step

### Parallel Opportunities

- T003 can run while T002 is updating backend dependencies
- T011 and T012 can run in parallel after foundational test doubles exist
- T013 can run in parallel with service test authoring, but must finish before T014-T016
- T021 and T022 can run in parallel
- T027 and T028 can run in parallel
- T032, T033, and T034 can run in parallel during polish

---

## Parallel Example: User Story 1

```bash
# Author backend tests in parallel:
Task: "Extend backend/tests/contract/document.contract.test.ts with multipart import acceptance"
Task: "Create backend/tests/unit/document-import-service.test.ts"
Task: "Create backend/tests/unit/document-source-content.test.ts"

# After tests exist, parallelize independent implementation slices:
Task: "Implement packages/document-parser/index.js and packages/document-parser/parsers/*"
Task: "Create backend/src/modules/documents/services/documentImportService.ts"
Task: "Create backend/src/modules/documents/services/documentSourceContentService.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases
2. Deliver US1 end to end: parser package, upload endpoint, async processing integration, and Documents import UI
3. Stop and validate a supported-file upload before expanding failure and cleanup behavior

### Incremental Delivery

1. Build the shared package and source/storage seams
2. Add the happy-path import flow (US1)
3. Harden rejection and failure behavior (US2)
4. Finish reprocess and delete lifecycle behavior (US3)
5. Update contracts/docs and run final validation

### Notes

- Preserve the current manual text document flow throughout the feature
- Prefer new focused services over adding conditional logic to `documentIngestionService.ts` and `documentRoutes.ts`
- Keep imported-file editing semantics out of scope; the UI should treat import as a separate action from manual text authoring
