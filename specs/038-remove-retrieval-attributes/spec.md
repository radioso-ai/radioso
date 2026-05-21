# Feature Specification: Remove Retrieval Attribute Extraction

**Feature Branch**: `038-remove-retrieval-attributes`  
**Created**: 2026-04-14  
**Status**: Draft  
**Input**: User description: "Remove everything related to the ingestion-time retrieval attribute extraction feature"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ingest Documents Without Attribute-Extraction Token Spend (Priority: P1)

As a workspace operator, I want document ingestion to stop calling attribute-extraction LLM logic so that ingestion cost and latency no longer scale with chunk count for a feature I am not using.

**Why this priority**: This is the core value of the change. If ingestion still performs per-chunk extraction or constraint parsing, the main product concern remains unresolved.

**Independent Test**: Can be fully tested by ingesting or reprocessing representative documents and confirming that the ingestion path completes without any document-attribute extraction prompt calls while embeddings and normal chunk storage continue to work.

**Acceptance Scenarios**:

1. **Given** a workspace ingesting a document, **When** document processing runs, **Then** the system stores chunks and embeddings without invoking per-chunk attribute extraction.
2. **Given** a workspace reprocessing existing documents, **When** the worker rebuilds chunks, **Then** reprocessing completes without any date, price, or location extraction step.

---

### User Story 2 - Retrieve And Answer Without Attribute-Specific Branches (Priority: P2)

As an end user asking grounded questions, I want retrieval and answer generation to continue working after the attribute feature is removed so that the product keeps its core retrieval quality without hidden legacy branches for fixed attribute families.

**Why this priority**: Removing cost is not enough if the retrieval pipeline or prompt assembly keeps dead compatibility hooks or user-visible regressions.

**Independent Test**: Can be fully tested by running representative retrieval and chat scenarios and confirming that semantic retrieval, lexical retrieval, reranking, citations, and prompt assembly still succeed without attribute summaries or attribute-based candidate scoring.

**Acceptance Scenarios**:

1. **Given** a grounded chat request, **When** retrieval runs, **Then** semantic retrieval, lexical retrieval, and reranking continue to produce usable contexts without attribute-based ranking or filtering.
2. **Given** a grounded answer with citations, **When** the prompt is assembled, **Then** the prompt omits legacy attribute summaries and still includes the retrieved chunk content needed for answer generation.

---

### User Story 3 - Remove The Feature Cleanly From Code And Storage (Priority: P3)

As an engineer maintaining Radioso, I want the attribute-extraction feature removed end to end so that the codebase, diagnostics, tests, and schema no longer imply support for four fixed extracted attribute families.

**Why this priority**: Partial removal leaves dead code, misleading diagnostics, and schema drift that will keep confusing future work on ingestion and retrieval.

**Independent Test**: Can be fully tested by code search, migration review, and targeted regression coverage showing that the extraction services, constraint services, dedicated tests, and structured-attributes storage column are no longer part of the active feature set.

**Acceptance Scenarios**:

1. **Given** the backend codebase after this feature ships, **When** engineers inspect ingestion and retrieval modules, **Then** they do not find active services or wiring for date-point, date-range, money, or location extraction.
2. **Given** an upgraded database, **When** migrations run, **Then** the legacy `chunks.structured_attributes` column is removed or explicitly retired from active writes and reads.

### Edge Cases

- What happens when legacy chunks exist without the old `structured_attributes` column values or with malformed values?
- What happens when a workspace reprocesses documents after the feature ships but before all application instances have restarted?
- How does the system behave when retrieval diagnostics or audit events contain legacy parsed-constraint metadata from earlier releases?
- What happens when existing tests, fixtures, or generated OpenAPI artifacts still reference the removed attribute feature?

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
- Backend API contracts MUST remain code-first and any HTTP contract change must regenerate generated OpenAPI artifacts instead of hand-editing them.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Document routes remain transport-only, document processing remains orchestration-only, retrieval services remain responsible for retrieval-stage behavior, and repositories remain the only owners of chunk persistence and schema interaction.
- **Encapsulation Rule**: [`backend/src/modules/documents/services/documentProcessingService.ts`](/Users/dm/conductor/workspaces/radioso/atlanta/backend/src/modules/documents/services/documentProcessingService.ts) must remain focused on materializing content, chunking, building retrieval text, embedding, and publishing chunks rather than absorbing new extraction logic. [`backend/src/modules/retrieval/services/retrievalPipelineService.ts`](/Users/dm/conductor/workspaces/radioso/atlanta/backend/src/modules/retrieval/services/retrievalPipelineService.ts) must not keep no-op compatibility branches for removed attribute families beyond the minimum needed to preserve stable diagnostics during transition.
- **New Seams Required**: Introduce, if needed, a small neutral query-diagnostics type surface for parsed-query metadata that is not coupled to the removed four-family attribute model.
- **Anti-Goals**: Do not replace the removed feature with another hidden per-chunk text-generation step. Do not keep dead extraction services, feature-specific enums, or UI labels in place “just in case.” Do not leave the database column actively written while claiming the feature is removed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST stop performing ingestion-time extraction of chunk-level `datePoints`, `dateRanges`, `moneyValues`, and `locations`.
- **FR-002**: The system MUST stop invoking any text-generation prompt whose purpose is document attribute extraction during ingestion or reprocessing.
- **FR-003**: The system MUST continue generating chunk embeddings and storing chunks for retrieval after the attribute feature is removed.
- **FR-004**: The system MUST remove attribute-based candidate scoring and filtering from retrieval.
- **FR-005**: The system MUST stop adding attribute summaries to retrieval prompts used for answer generation.
- **FR-006**: The system MUST remove active runtime wiring for the document-attribute extraction service and semantic query-constraint service.
- **FR-007**: The system MUST remove the legacy `structured_attributes` chunk persistence path from active reads and writes.
- **FR-008**: The system MUST provide a database migration or equivalent schema step that retires the `chunks.structured_attributes` column from active storage.
- **FR-009**: The system MUST remove dedicated unit and integration coverage whose only purpose was validating the deleted attribute feature, while preserving or updating regression tests for the remaining retrieval path.
- **FR-010**: The system MUST keep retrieval diagnostics coherent after the feature removal, including safe handling of legacy audit metadata produced before the removal.
- **FR-011**: The system MUST remove product-facing or operator-facing references that imply the four fixed attribute families are still supported.
- **FR-012**: The system MUST preserve baseline grounded-chat behavior for semantic retrieval, lexical retrieval, reranking, and citations.

### Key Entities *(include if feature involves data)*

- **Legacy Retrieval Attribute Feature**: The removed ingestion-and-retrieval subsystem that extracted and used four chunk-level attribute families: dates, date ranges, money values, and locations.
- **Chunk Record**: The persisted retrieval unit that remains responsible for chunk text, retrieval search text, embeddings, offsets, and metadata after attribute removal.
- **Retrieval Diagnostics**: The debug and audit metadata emitted by retrieval and chat flows, which may need a generic query-summary shape after removal of attribute-specific structures.
- **Legacy Chunk Schema**: The previous `chunks` table shape that included `structured_attributes`, retained only as a migration concern.

## Assumptions

- The product no longer depends on hard-coded date, location, or money extraction for acceptable baseline retrieval quality.
- Removing the feature is preferable to adding a user-facing toggle because the feature is considered low-value relative to cost and complexity.
- Existing historical audit events may continue to contain legacy attribute or constraint payloads, but newly generated events should not depend on those shapes.
- A minimal neutral diagnostics type is acceptable if retrieval tracing still needs parsed-query or applied-rule summaries for non-attribute features.
- Metadata rules remain in scope as a separate feature and are not removed by this change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In covered ingestion and reprocessing tests, zero document-attribute extraction prompt calls occur per processed chunk or per processed document.
- **SC-002**: Code search across the backend source and active tests finds no active runtime references to the four removed extracted attribute families outside historical migrations or legacy-data compatibility checks.
- **SC-003**: Targeted retrieval and chat regression tests continue to pass for semantic retrieval, lexical retrieval, reranking, citations, and benchmark scenarios after the removal.
- **SC-004**: Database migrations and repository code no longer rely on active writes or reads to `chunks.structured_attributes`.
- **SC-005**: The backend no longer exposes operator or developer-facing API/schema language implying support for the removed fixed attribute families.
