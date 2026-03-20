# Feature Specification: Document Import and GCS Storage

**Feature Branch**: `020-document-import-gcs`  
**Created**: 2026-03-20  
**Status**: Draft  
**Input**: User description: "Add a document parser package in /packages, backend file upload API with GCS-backed storage, and document import in the Documents frontend."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Import a supported document from Documents (Priority: P1)

A workspace user opens the Documents screen, uploads a supported file, and sees the document appear in the list with processing status so the content can be searched in chat after ingestion completes.

**Why this priority**: This is the core product value. Without a usable import flow for real files, the parser package and storage work do not help end users.

**Independent Test**: Can be fully tested by uploading one supported file from the Documents page and verifying that the document is accepted, queued, listed, and later available for retrieval.

**Acceptance Scenarios**:

1. **Given** an authenticated workspace user on the Documents screen, **When** they upload a supported file with an optional title override, **Then** the system stores the original file, creates a document record, and returns a queued document result.
2. **Given** an uploaded document is still processing, **When** the user views the Documents list, **Then** they can see the document with pending status and identifying details from the upload.
3. **Given** an uploaded document finishes processing successfully, **When** the user asks a relevant chat question, **Then** the imported content is eligible for retrieval like other documents.

---

### User Story 2 - Reject invalid or unsupported uploads safely (Priority: P2)

A workspace user gets immediate, clear feedback when an upload cannot be accepted because the file type is unsupported, the file is empty, or the upload cannot be stored or parsed.

**Why this priority**: File import introduces new failure modes and customer data handling risk. Clear rejection behavior prevents broken or misleading document states.

**Independent Test**: Can be fully tested by submitting unsupported, empty, and failed-storage uploads and verifying that each case returns a clear failure without producing a usable document.

**Acceptance Scenarios**:

1. **Given** a user uploads an unsupported file type, **When** the upload request is validated, **Then** the system rejects the request with a clear error and does not create a queued document.
2. **Given** a file upload cannot be stored or parsed, **When** processing runs, **Then** the document is marked failed with a visible failure reason and the system records the failure for operators.
3. **Given** a user uploads a zero-byte or malformed supported file, **When** the system attempts import, **Then** the system fails safely without exposing partial or misleading content.

---

### User Story 3 - Reprocess imported files from the stored original (Priority: P3)

A workspace user can reprocess an imported document without re-uploading the file, and the system uses the original stored file as the source of truth.

**Why this priority**: Once files are stored outside Postgres, reprocessing needs a stable source. This protects future parser improvements and operational recovery.

**Independent Test**: Can be fully tested by importing a file, triggering reprocess, and verifying that the system reuses the stored original file instead of requiring new upload content.

**Acceptance Scenarios**:

1. **Given** an imported document already has an original stored file, **When** the user requests reprocessing, **Then** the system requeues the document using the stored original file.
2. **Given** the original stored file is unavailable, **When** reprocessing is requested, **Then** the system marks the reprocess attempt as failed with a clear reason rather than silently succeeding.

### Edge Cases

- A supported upload exceeds the configured size limit and must be rejected before storage or processing begins.
- A `.xlsx` file contains multiple sheets; extracted content must preserve enough structure for users to understand which sheet the text came from.
- A `.pdf` file contains little or no extractable text; the system must fail clearly rather than pretending the document is ready.
- A storage write succeeds but downstream parsing fails; the document must not be marked ready.
- A user deletes an imported document; the stored original file must not remain orphaned.
- Localhost runs without valid GCP credentials; uploads must fail with a clear operator-facing reason rather than hanging or creating ambiguous records.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: `frontend/components/dashboard/documents-view.tsx` owns import UI only; backend HTTP routes own request parsing and auth only; document orchestration services own import/reprocess workflow; a dedicated storage adapter owns object storage access; the new `/packages` parser module owns file-type detection and text extraction only; repositories remain responsible for database persistence only.
- **Encapsulation Rule**: `backend/src/modules/documents/services/documentIngestionService.ts` must remain orchestration-focused and must not absorb multipart parsing, GCS client setup, or file-format-specific extraction logic. `frontend/lib/api.ts` must remain a thin transport client and must not encode parsing rules.
- **New Seams Required**:
  - A new package under `/packages` for document parsing that is importable without backend/core dependencies.
  - A dedicated backend document import service that coordinates storage, parser execution, and handoff into the existing async document-processing flow.
  - A storage port and GCS-backed adapter for saving, reading, and deleting original uploaded files.
  - A document source model that distinguishes imported files from manually entered text without forcing binary data into existing text-only code paths.
- **Anti-Goals**:
  - Do not place parser implementation inside Express route handlers.
  - Do not store uploaded binary files in PostgreSQL document content columns.
  - Do not make the parser package import backend services, repositories, or environment code.
  - Do not require a Settings toggle for the import feature.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support document import for `.pdf`, `.txt`, `.docx`, and `.xlsx` files from the Documents frontend by default.
- **FR-002**: Users MUST be able to upload a supported file from the Documents screen using the same authenticated workspace context as existing document actions.
- **FR-003**: System MUST accept file uploads through a backend document upload API that creates a workspace-scoped document record and queues asynchronous processing.
- **FR-004**: System MUST store the original uploaded file in a GCP Cloud Storage bucket before the document is marked ready for retrieval.
- **FR-005**: System MUST use a parser module in `/packages` that can be imported independently of backend/core code and returns normalized textual content for supported file types.
- **FR-006**: System MUST feed extracted content from imported files into the existing document processing and retrieval pipeline so imported files behave like other documents in chat and search.
- **FR-007**: System MUST preserve source details for imported documents, including original filename, detected file type, and enough storage metadata to support reprocessing and deletion.
- **FR-008**: System MUST allow users to reprocess an imported document from the stored original file without requiring a new upload.
- **FR-009**: System MUST reject unsupported, empty, malformed, or over-limit uploads with clear user-facing errors and without creating misleading ready documents.
- **FR-010**: System MUST surface import processing failures in document status so users and operators can distinguish failed imports from still-pending work.
- **FR-011**: System MUST delete the stored original file when the corresponding document is permanently deleted, or record a recoverable failure if cleanup cannot be completed immediately.
- **FR-012**: System MUST support local backend development against GCP storage through non-committed configuration, including an explicit local credentials path or equivalent application-default credentials workflow.
- **FR-013**: System MUST update environment documentation and example configuration for every new storage bucket or credential setting required by this feature.

### UI Tasks

- Add an import action to the Documents screen that lets users choose a supported file and optionally edit the document title before upload.
- Show import validation and failure messages inline in the Documents experience without redirecting users to Settings.
- Display imported documents in the existing list with enough status and identifying information for users to understand what was uploaded and whether processing succeeded.

### Key Entities *(include if feature involves data)*

- **Imported Document Source**: The source record for an uploaded document, including workspace ownership, original filename, detected file type, storage location, and source lifecycle state.
- **Parsed Document Payload**: The normalized textual representation extracted from an uploaded file and handed into the existing document ingestion and chunking flow.
- **Document Import Attempt**: The upload and processing attempt for a workspace document, including acceptance outcome, failure reason when relevant, and timestamps needed for audit and recovery.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A workspace user can upload a supported document from the Documents screen and receive a queued result in under 10 seconds for 95% of files up to the configured size limit.
- **SC-002**: 100% of successfully imported supported files appear in the Documents list with a non-ambiguous processing state before retrieval becomes available.
- **SC-003**: 100% of unsupported or invalid uploads are rejected with an explicit error message and do not appear as ready documents.
- **SC-004**: A user can reprocess a previously imported document without re-uploading the file in 100% of cases where the original stored file still exists.
- **SC-005**: Local development setup for file import can be completed from repository documentation without committing credentials or editing source code.

## Out of Scope

- OCR for scanned or image-only documents.
- Legacy Microsoft Office binary formats such as `.doc` and `.xls`.
- Direct browser-to-cloud signed upload flows.
- New Settings controls for enabling or disabling document import.

## Assumptions

- The existing text-based document create and edit flow remains available.
- Imported documents continue using the existing async processing worker after text extraction completes.
- Localhost development may use an explicit credentials file path or application-default credentials, but the repository will not contain committed cloud keys.
