# Implementation Plan: Core Document Import and GCS Storage

**Branch**: `020-document-import-gcs` | **Date**: 2026-03-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/020-document-import-gcs/spec.md`

## Summary

Add a default-on document import flow to the existing Documents UI as a core backend capability, backed by a new local parser package under `/packages`, a backend multipart upload API, and GCP Cloud Storage for original uploaded files. The backend will preserve the existing text-based document flow while adding a file-backed path that stores binary source files, parses them during async processing, and supports reprocessing from the stored original object.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 + React 19 + Next.js 16 (frontend), ESM local package under `/packages`
**Primary Dependencies**: Express, Zod, `pg`, Vitest, Supertest, `@google-cloud/storage`, route-scoped multipart parsing, and file-format parsers for PDF, DOCX, TXT, and XLSX  
**Storage**: PostgreSQL 16 for document metadata and extracted text; GCP Cloud Storage bucket for original uploaded files  
**Testing**: Backend Vitest unit/contract/integration tests, frontend `eslint`, manual upload smoke validation for supported file types  
**Target Platform**: Backend API host on Node.js, browser-based Documents UI, GCP Cloud Storage for object persistence  
**Project Type**: Web application with backend, frontend, and local shared packages  
**Performance Goals**: Upload acceptance returns within 10 seconds for supported files up to the configured limit; async processing remains non-blocking for the request path  
**Constraints**: Preserve the existing JSON document create/edit flow; parser package must not depend on backend/core code; no committed cloud credentials; no signed direct-upload flow; no OCR or legacy Office binary support  
**Scale/Scope**: Workspace-scoped imports for four file types, one new local package, one new upload endpoint, additive document schema changes, and UI updates limited to the Documents experience

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec exists and is approved**: PASS — approved spec at `specs/020-document-import-gcs/spec.md`.
- **Backend work includes TDD**: PASS — backend contract/unit/integration tests will be added before implementation for upload, parsing, storage, reprocess, and deletion paths.
- **Stack remains Node.js for backend and React for frontend**: PASS — all app changes stay within the existing TypeScript/Express/Next.js stack.
- **Database remains PostgreSQL with pgvector**: PASS — document metadata remains in PostgreSQL; retrieval continues using the existing chunk and embedding flow.
- **LLM provider remains GPT-5.2**: PASS — no LLM integration changes.
- **Secrets and keys managed via `.env`**: PASS — bucket configuration will be added to backend env handling and `.env.example`; local credentials rely on non-committed standard GCP credential env.
- **Customer data handling and auditability addressed**: PASS — original files move to GCS with explicit workspace-scoped storage metadata, deletion handling, and audit events on import/process/delete failure paths.
- **Module boundaries explicit**: PASS — route parsing, orchestration, file parsing, object storage, and persistence are separated into explicit backend layers and ports, while file parsing stays isolated in an internal package.
- **Responsibility-limited files identified**: PASS — `documentRoutes.ts`, `documentIngestionService.ts`, `documentProcessingService.ts`, `frontend/lib/api.ts`, and `documents-view.tsx` remain thin/orchestration-focused.
- **Architecture/refactor stories needed first**: PASS — no blocking refactor is required if import logic lands in new focused modules rather than existing document services.

## Project Structure

### Documentation (this feature)

```text
specs/020-document-import-gcs/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── document-import.openapi.yaml
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── config/env.ts
│   │   ├── http/routes/documentRoutes.ts
│   │   └── server/
│   │       ├── dependencies.ts
│   │       └── types.ts
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/documentRepository.ts
│   └── modules/documents/
│       ├── services/
│       │   ├── documentDeletionService.ts
│       │   ├── documentIngestionService.ts
│       │   ├── documentProcessingService.ts
│       │   ├── documentImportService.ts              # NEW
│       │   └── documentSourceContentService.ts       # NEW
│       └── infra/
│           └── gcsDocumentStorage.ts                 # NEW
├── tests/
│   ├── contract/document.contract.test.ts
│   ├── integration/persistence.integration.test.ts
│   ├── unit/document-ingestion.test.ts
│   ├── unit/document-deletion.test.ts
│   └── support/
│       ├── fakes.ts
│       └── testApp.ts
frontend/
├── components/dashboard/documents-view.tsx
└── lib/api.ts
packages/
└── document-parser/
    ├── index.js
    ├── index.d.ts
    ├── package.json
    └── parsers/
        ├── pdf.js
        ├── txt.js
        ├── docx.js
        └── xlsx.js
```

**Structure Decision**: Keep document import in the existing backend/frontend application layout as core product functionality and introduce one local runtime package under `/packages` only for file extraction. Backend orchestration lives in focused document services, object storage lives behind a GCS adapter, and file extraction logic lives only in the parser package. The existing document route and service files remain thin entry points rather than becoming format- or storage-aware god objects.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/documentRoutes.ts` and `frontend/lib/api.ts` translate HTTP/UI interactions only.
- **Orchestration Layer**: `documentIngestionService.ts`, `documentImportService.ts`, and `documentDeletionService.ts` coordinate import, reprocess, and delete workflows.
- **Domain Layer**: `documentSourceContentService.ts` decides how a document revision materializes text (`inline_text` versus `uploaded_file`) before chunking.
- **Persistence/Integration Layer**: `documentRepository.ts` owns document schema persistence; `gcsDocumentStorage.ts` owns bucket reads/writes/deletes; the parser package owns byte-to-text extraction only.
- **Files Kept Small**: `documentRoutes.ts`, `documentIngestionService.ts`, `documentProcessingService.ts`, `frontend/lib/api.ts`, and `frontend/components/dashboard/documents-view.tsx`.
- **Planned Extractions**:
  - `DocumentImportService` for upload acceptance and document creation
  - `DocumentSourceContentService` for worker-time source loading/parsing
  - `DocumentStoragePort` and a GCS adapter
  - `@hivec/document-parser` as a local importable package
- **Required Refactor Stories**: None. The feature can land safely via additive modules.

## Complexity Tracking

No constitution violations to justify.

## Implementation Phases

### Phase 0: Research and design lock-in

1. Confirm endpoint, storage, parser packaging, and reprocess strategy.
2. Define additive document schema changes and API contract additions.
3. Document local-development credential workflow and deletion semantics.

### Phase 1: Foundational seams

1. Add a new local parser package and backend dependency entry.
2. Extend document persistence types and database schema for file-backed sources.
3. Introduce storage and source-materialization ports plus test doubles.
4. Add backend env support for the document bucket configuration.

### Phase 2: User Story 1 (P1) upload and processing path

1. Add multipart upload route and request validation for supported files.
2. Store original file objects in GCS and create queued document records with source metadata.
3. Materialize uploaded file content during async processing and persist extracted text for retrieval.
4. Add Documents UI import action and upload UX without disturbing the existing manual text flow.

### Phase 3: User Story 2 (P2) failure handling

1. Reject unsupported, empty, and over-limit uploads before queuing work.
2. Surface parse/storage failures as document failures with clear error responses and UI feedback.
3. Preserve audit logging for failed acceptance, processing, and deletion attempts.

### Phase 4: User Story 3 (P3) reprocess and cleanup

1. Reprocess uploaded files by re-reading the original stored object.
2. Delete file-backed documents by removing the DB row first and then attempting stored-object cleanup so transient database failures cannot erase the source file first.
3. Validate recoverable failure behavior for missing objects and storage cleanup errors.

### Phase 5: Polish and validation

1. Update OpenAPI and environment examples.
2. Run backend targeted test suites plus frontend lint.
3. Complete manual quickstart validation for local credentials and supported uploads.
