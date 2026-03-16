# Feature Specification: Async Document Processing

**Feature Branch**: `012-async-document-processing`  
**Created**: 2026-03-16  
**Status**: Draft  
**Input**: User description: "Move document ingestion to durable async background processing with status tracking, retries, and non-blocking document create/update flows"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Submit Documents Without Blocking (Priority: P1)

As an operator managing knowledge-base documents, I want document create and update requests to be accepted quickly so I do not have to wait for full processing before continuing my work.

**Why this priority**: This directly addresses the current bottleneck and changes the core user experience from blocking to non-blocking.

**Independent Test**: Can be fully tested by creating or updating a document and verifying the request completes quickly while the document remains available with a non-final processing state.

**Acceptance Scenarios**:

1. **Given** an authenticated operator submits a valid new document, **When** the system accepts the request, **Then** it records the document, places it into an asynchronous processing flow, and returns an accepted response without waiting for final retrieval preparation.
2. **Given** an authenticated operator updates an existing document, **When** the system accepts the request, **Then** it records the latest content as the new version to process and returns without waiting for final retrieval preparation.

---

### User Story 2 - Track Processing Progress and Failures (Priority: P2)

As an operator, I want to see whether a document is queued, processing, ready, or failed so I know when the document can be used for retrieval and when corrective action is required.

**Why this priority**: Once processing becomes asynchronous, clear status visibility is required for trust and usability.

**Independent Test**: Can be fully tested by creating a document, observing the document list or detail state transition through non-final states, and confirming a failure is shown when processing does not complete successfully.

**Acceptance Scenarios**:

1. **Given** a document has been accepted for background processing, **When** an operator views that document in the product, **Then** the current processing state is shown accurately until completion.
2. **Given** document processing fails, **When** an operator views that document, **Then** the document is marked failed and the failure is visible without exposing secrets or unsafe internal data.

---

### User Story 3 - Protect Latest Content From Stale Work (Priority: P3)

As an operator, I want the latest accepted document update to win even if older processing work finishes later so retrieval never serves superseded content.

**Why this priority**: Asynchronous processing introduces race conditions; without explicit protection, delayed jobs can overwrite newer document state.

**Independent Test**: Can be fully tested by updating the same document multiple times in quick succession and confirming only the newest accepted version becomes the active processed result.

**Acceptance Scenarios**:

1. **Given** a document has multiple accepted updates in close succession, **When** background processing completes out of order, **Then** only the newest accepted revision can become the active ready result.
2. **Given** the service restarts after accepting a document for processing, **When** processing resumes, **Then** the accepted document is still processed or surfaced as failed rather than silently lost.

### Edge Cases

- A document is updated again while a previous revision is still queued or processing.
- A document is deleted after being accepted for processing but before the background work finishes.
- Background processing fails after partial work has been produced for a document revision.
- A worker restarts or crashes while claiming or processing a document job.
- A large document stays in a non-final state longer than smaller documents; the system must still report an accurate state instead of timing out the request path.

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

- **Boundary Rule**: HTTP routes own authentication, validation, and response shaping only. Document command orchestration owns request-time acceptance of create and update actions. Background processing owns chunk preparation, embedding generation, retry handling, and final document state transitions. Persistence owns document records, processing-job records, and chunk storage.
- **Encapsulation Rule**: [`backend/src/app/http/routes/documentRoutes.ts`](/Users/dm/code/hivec-async-document-processing/backend/src/app/http/routes/documentRoutes.ts) must remain transport-only. [`backend/src/modules/documents/services/documentIngestionService.ts`](/Users/dm/code/hivec-async-document-processing/backend/src/modules/documents/services/documentIngestionService.ts) must not continue as a mixed request-path and worker-path god service; the feature must either split or clearly narrow that responsibility.
- **New Seams Required**: A focused document command service for request-time acceptance, a durable processing-job repository, a dedicated processing worker/service, and a clear revision-safety seam that decides whether a completed job is still current before publishing results.
- **Anti-Goals**: Do not add long-running processing back into route handlers. Do not use an in-memory queue as the durable source of truth. Do not let stale processing overwrite a newer accepted document revision. Do not hide failed states behind indefinite "processing" labels.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST accept valid document create requests without waiting for final retrieval preparation to complete.
- **FR-002**: The system MUST accept valid document update requests without waiting for final retrieval preparation to complete.
- **FR-003**: The system MUST persist accepted document work in a durable processing queue so accepted work is not lost across process restarts.
- **FR-004**: The system MUST expose document processing states that distinguish at minimum queued, processing, ready, and failed outcomes.
- **FR-005**: The system MUST make the current processing state available through the existing document list and document detail experiences.
- **FR-006**: The system MUST retry recoverable processing failures according to a defined policy and surface a terminal failed state when processing cannot be completed successfully.
- **FR-007**: The system MUST ensure that only the latest accepted document revision can publish active processed content for retrieval.
- **FR-008**: The system MUST prevent deleted documents from reappearing through late-arriving background work.
- **FR-009**: The system MUST preserve account scoping and only allow processing and status updates within the owning account context.
- **FR-010**: The system MUST record auditable outcomes for accepted, completed, and failed document processing actions.
- **FR-011**: The system MUST keep existing retrieval behavior limited to documents whose processing state is ready.
- **FR-012**: The system MUST provide a user-visible way to recover from terminal document failures without requiring direct database intervention.

### UI Tasks

- Document creation and editing flows must close or return control promptly after the request is accepted instead of waiting for a completed ready state.
- The documents list must show the current processing state for each document with distinct queued, processing, ready, and failed feedback.
- Document detail and edit flows must preserve access to the latest saved source content even while background processing is still running.
- Failed documents must show a clear recovery action, such as retrying through an update or reprocess action, without requiring support intervention.

### Key Entities *(include if feature involves data)*

- **Document Revision**: The latest accepted version of a document's source content and metadata, including the processing state that operators see and retrieval depends on.
- **Document Processing Job**: A durable record of accepted background work for a specific document revision, including readiness to run, attempt history, and terminal outcome.
- **Processed Retrieval Content**: The chunked and indexed representation that becomes active only when the corresponding document revision is still current and finishes successfully.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In routine conditions, 95% of document create and update requests return an acceptance response in under 3 seconds rather than waiting for full processing completion.
- **SC-002**: 100% of accepted document requests remain recoverable after an application restart, either by continuing toward completion or by surfacing a failed state that operators can act on.
- **SC-003**: In concurrency tests where the same document is updated multiple times in close succession, 100% of ready results reflect the latest accepted revision rather than an older superseded revision.
- **SC-004**: Operators can determine whether a document is queued, processing, ready, or failed from the product UI without opening server logs or database tools.

## Assumptions

- The initial release will use the existing PostgreSQL system as the durable queue store rather than introducing a new external queue platform.
- The initial user experience can rely on status refresh or polling; real-time push updates are not required for feature acceptance.
- Recovery from terminal failure may be satisfied by re-running document update or a similarly direct operator action, provided it is available through the product.
