# Feature Specification: Document Metadata

**Feature Branch**: `015-document-metadata`
**Created**: 2026-03-18
**Status**: Draft
**Input**: User description: "Optional document metadata (source URL, name, language) stored as flexible key-value pairs, propagated to chunks for retrieval filtering"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Attach Metadata to Documents (Priority: P1)

A user uploads a document via the API and includes optional metadata such as source URL, document name, or language. The metadata is stored alongside the document and automatically propagated to all chunks created during ingestion.

**Why this priority**: Without metadata storage, there is nothing to filter or display. This is the foundational capability that all other stories depend on.

**Independent Test**: Upload a document with metadata via POST, retrieve it via GET, and confirm the metadata is returned. Verify chunks also carry the metadata.

**Acceptance Scenarios**:

1. **Given** a user with a valid workspace API token, **When** they POST a document with a `metadata` field containing `{ "sourceUrl": "https://example.com", "language": "en" }`, **Then** the document is created and the metadata is persisted.
2. **Given** a document uploaded with metadata, **When** the user retrieves the document via GET, **Then** the response includes the metadata exactly as submitted.
3. **Given** a document uploaded with metadata, **When** the document is chunked during ingestion, **Then** each chunk carries a copy of the document's metadata.
4. **Given** a user uploading a document without a `metadata` field, **When** the document is created, **Then** it is stored with an empty metadata object and ingestion proceeds normally.

---

### User Story 2 - Metadata Available in Retrieval Context (Priority: P1)

When the retrieval pipeline returns chunks as context for a chat answer, the chunk metadata is included so the LLM can reference source URLs, document names, or other metadata in its response.

**Why this priority**: This is the core value proposition — metadata makes retrieval answers more useful by enabling source attribution and context.

**Independent Test**: Upload a document with a `sourceUrl` in metadata, ask a question that retrieves chunks from that document, and verify the LLM response can cite the source URL.

**Acceptance Scenarios**:

1. **Given** chunks with metadata exist, **When** the retrieval pipeline selects those chunks, **Then** the metadata is included in the prompt context sent to the LLM.
2. **Given** a document with `sourceUrl` metadata, **When** a user asks a question and the system retrieves that document's chunks, **Then** the answer can reference the source URL.

---

### User Story 3 - Filter Retrieval by Metadata (Priority: P2)

A user can constrain their chat queries to only search documents matching specific metadata criteria. For example, searching only documents in a particular language or from a specific source.

**Why this priority**: Filtering adds precision to retrieval but is not required for the basic metadata flow to deliver value.

**Independent Test**: Upload two documents with different `language` metadata, ask a question with a metadata filter, and verify only chunks from the matching document are returned.

**Acceptance Scenarios**:

1. **Given** documents with different `language` metadata exist, **When** a user sends a chat message with a metadata filter `{ "language": "en" }`, **Then** only chunks from English documents are considered during retrieval.
2. **Given** a metadata filter that matches no documents, **When** retrieval runs, **Then** the system returns no results gracefully and the LLM responds accordingly.

---

### Edge Cases

- What happens when metadata contains deeply nested objects? The system accepts and stores them but only top-level keys are usable for filtering.
- What happens when metadata keys conflict with internal fields? Metadata is stored in a dedicated field, so no conflict is possible.
- What happens when a document's metadata is updated after chunking? Existing chunks retain the metadata from ingestion time. Re-ingestion would propagate updated metadata.
- What happens when metadata values are very large (e.g., a 10KB string)? The system enforces a maximum size limit on the metadata object (16 KB).

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

- **Boundary Rule**: Document routes handle transport (validation, serialization). DocumentIngestionService owns orchestration (chunking + metadata propagation). Repositories own persistence. Retrieval pipeline owns filtering.
- **Encapsulation Rule**: `documentRoutes.ts` must remain transport-only — no metadata validation logic beyond schema parsing. `chatService.ts` must remain orchestration-only — metadata filtering belongs in the retrieval pipeline, not the chat handler.
- **New Seams Required**: No new services needed. Metadata is a property of documents and chunks, flowing through existing ingestion and retrieval paths.
- **Anti-Goals**: Do not add metadata filtering logic to chat routes or chat service. Do not create a separate metadata table — use a JSONB column on existing tables. Do not require metadata — it must always be optional.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept an optional `metadata` field (arbitrary key-value object) on document creation via the API.
- **FR-002**: System MUST persist document metadata as a flexible structure that does not require schema changes when new keys are added.
- **FR-003**: System MUST propagate document metadata to all chunks created during ingestion.
- **FR-004**: System MUST return metadata in document GET responses.
- **FR-005**: System MUST include chunk metadata in the retrieval context provided to the LLM prompt builder.
- **FR-006**: System MUST support filtering retrieval results by metadata key-value matches.
- **FR-007**: System MUST enforce a maximum size limit on the metadata object (16 KB) to prevent abuse.
- **FR-008**: System MUST treat missing metadata as an empty object — no special handling required.
- **FR-009**: System MUST index metadata for efficient filtering queries.

### Key Entities

- **Document**: Gains a `metadata` property — a flexible key-value map. Examples: `sourceUrl`, `language`, `documentName`, `author`, `category`.
- **Chunk**: Gains a `metadata` property copied from its parent document at ingestion time. Used during retrieval for filtering and context enrichment.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can upload documents with metadata and retrieve them with metadata intact in under 2 seconds.
- **SC-002**: Retrieval responses include metadata from source chunks, enabling the LLM to cite source URLs when available.
- **SC-003**: Metadata filtering reduces the retrieval candidate set to only matching documents, verified by uploading documents with distinct metadata and confirming isolation.
- **SC-004**: Documents uploaded without metadata continue to work identically to the current behavior — no regressions.
