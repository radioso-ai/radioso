# Feature Specification: External Document ID

**Feature Branch**: `037-external-document-id`  
**Created**: 2026-04-14  
**Status**: Draft  
**Input**: User description: "Support optional immutable externalDocumentId on document writes with tenant-scoped idempotency on the existing document contract, with no external-id query endpoints or separate external-id endpoints."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Idempotent External Writes (Priority: P1)

An integration syncs documents from another system into a workspace. When it includes an `externalDocumentId` on a document write, repeating the same write later updates the same logical document instead of creating duplicates.

**Why this priority**: This is the core product value. Without tenant-scoped idempotent writes, external systems cannot safely retry sync jobs or reconcile updates.

**Independent Test**: Send two document create requests to the existing document write contract in the same workspace with the same `externalDocumentId` and different content. Confirm that only one document exists and that the second write updates the original document rather than creating another one.

**Acceptance Scenarios**:

1. **Given** a workspace with no matching document, **When** a caller submits a document write containing `externalDocumentId = "crm-123"`, **Then** the system creates a new document with a server-generated internal document ID.
2. **Given** a workspace that already has a document with `externalDocumentId = "crm-123"`, **When** a caller submits another document write with `externalDocumentId = "crm-123"`, **Then** the system updates that same document and does not create a duplicate.
3. **Given** two workspaces, **When** each workspace submits a document write with `externalDocumentId = "crm-123"`, **Then** each workspace gets its own document and the writes do not conflict across tenants.

---

### User Story 2 - Preserve Existing Native Document Flows (Priority: P2)

Existing clients that do not use external identity continue to create, update, list, retrieve, and delete documents with the current internal Radioso document ID behavior.

**Why this priority**: This feature must not break the existing document model or require all clients to adopt external identity.

**Independent Test**: Exercise the current document create and update flows without `externalDocumentId` and confirm they behave the same as before, including creation of distinct documents for repeated create requests.

**Acceptance Scenarios**:

1. **Given** a caller submits a document write without `externalDocumentId`, **When** the request succeeds, **Then** the system behaves exactly like the current contract and creates a new document unless the caller explicitly targets an existing internal document ID through the existing update route.
2. **Given** an existing document created without `externalDocumentId`, **When** the document is retrieved, listed, reprocessed, or deleted, **Then** those flows continue to use the internal document ID as the canonical identifier.
3. **Given** an existing client integration that never sends `externalDocumentId`, **When** it continues sending writes after this feature ships, **Then** it requires no contract migration to preserve current behavior.

---

### User Story 3 - Stable Ownership of External Identity (Priority: P3)

Once an external system assigns an `externalDocumentId` to a document, that identity remains stable and cannot later be rewritten to point at a different external record.

**Why this priority**: Immutability prevents accidental reassignment, simplifies retry semantics, and avoids tenant-local identity drift.

**Independent Test**: Create or upsert a document with `externalDocumentId`, then attempt to change that external identity through a later write. Confirm the system rejects the change with a clear conflict response.

**Acceptance Scenarios**:

1. **Given** a document already has `externalDocumentId = "crm-123"`, **When** a caller tries to change it to `"crm-456"`, **Then** the system rejects the request and leaves the original identity unchanged.
2. **Given** a document without `externalDocumentId`, **When** a caller assigns one for the first time through an allowed write path, **Then** the assignment succeeds if that identity is not already claimed in the same workspace.
3. **Given** a workspace already has another document using `externalDocumentId = "crm-123"`, **When** a caller tries to assign `"crm-123"` to a different document in that workspace, **Then** the system rejects the request as a tenant-local conflict.

### Edge Cases

- What happens when two identical writes with the same `externalDocumentId` arrive concurrently in the same workspace? The system must produce one logical document and a deterministic winner for the persisted latest write, without duplicate rows.
- What happens when `externalDocumentId` is omitted? The system must preserve the current non-idempotent create behavior.
- What happens when `externalDocumentId` is an empty string or whitespace? The system must reject the request rather than treating it as a valid identity.
- What happens when a caller first creates a document without `externalDocumentId` and later assigns one? The first assignment may succeed, but any later attempt to change it must be rejected.
- What happens when an imported file-backed document is addressed through a write path that only supports inline documents? Existing source-kind restrictions must remain in force; this feature must not create a bypass.
- What happens when a retry arrives after the first write succeeded but before asynchronous processing completed? The retry must still target the same logical document and requeue processing safely rather than creating a second document.

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

- **Boundary Rule**: Document routes own request and response validation only. `DocumentIngestionService` owns create-versus-update orchestration for document writes. `DocumentRepository` owns tenant-scoped uniqueness and idempotent persistence behavior. Existing processing, retrieval, and deletion modules continue to treat the internal document ID as the canonical relational key.
- **Encapsulation Rule**: `documentRoutes.ts` must remain transport-only and must not embed uniqueness or idempotency logic. `DocumentIngestionService` must remain the orchestration entry point for document writes and must not push database conflict behavior into controllers. Retrieval and chat modules must not start querying by external identity.
- **New Seams Required**: Introduce a focused persistence seam for create-or-upsert-by-external-identity behavior so repository code can enforce tenant-local uniqueness and immutability without spreading conditional logic across unrelated document operations.
- **Anti-Goals**: Do not add external-ID lookup endpoints. Do not make the client-supplied external ID replace the internal document primary key. Do not treat a metadata field as the only source of truth for identity that requires database enforcement. Do not expand this feature into bidirectional sync, source-side deletes, or cross-workspace deduplication.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept an optional `externalDocumentId` field on document write requests for inline document creation and update flows covered by the existing document contract.
- **FR-002**: System MUST continue generating and returning the internal Radioso document ID as the canonical document identifier for existing read, list, update-by-ID, reprocess, and delete flows.
- **FR-003**: System MUST treat `externalDocumentId` as workspace-scoped identity rather than globally unique identity.
- **FR-004**: System MUST create a new document when a write includes an `externalDocumentId` that is not yet present in the target workspace.
- **FR-005**: System MUST update the existing document instead of creating a duplicate when a write includes an `externalDocumentId` that already exists in the target workspace.
- **FR-006**: System MUST preserve current create behavior for writes that omit `externalDocumentId`, including allowing repeated create requests to create separate documents.
- **FR-007**: System MUST reject blank or invalid `externalDocumentId` values rather than storing them as usable external identities.
- **FR-008**: System MUST make `externalDocumentId` immutable after it has been set on a document.
- **FR-009**: System MUST allow assigning `externalDocumentId` to a document that does not already have one only when that external identity is not already claimed by another document in the same workspace.
- **FR-010**: System MUST reject any request that would cause two documents in the same workspace to share the same `externalDocumentId`.
- **FR-011**: System MUST allow different workspaces to reuse the same `externalDocumentId` without conflict.
- **FR-012**: System MUST handle concurrent writes for the same workspace and `externalDocumentId` without creating duplicate documents.
- **FR-013**: System MUST requeue document processing appropriately when an idempotent write updates an existing document through `externalDocumentId`.
- **FR-014**: System MUST NOT introduce any endpoint for retrieving, listing, or searching documents by `externalDocumentId`.
- **FR-015**: System MUST keep existing source-kind restrictions in force; external identity support must not allow inline write paths to mutate document types that are currently protected.
- **FR-016**: System MUST expose `externalDocumentId` in document responses and in the generated API contract wherever document write and read payloads describe document identity.
- **FR-017**: System MUST update the code-first OpenAPI registry and generated API artifacts to reflect the additive request and response field.
- **FR-018**: System MUST preserve auditability of document write outcomes so operators can distinguish successful external-id writes from rejected tenant-local identity conflicts.

### Key Entities *(include if feature involves data)*

- **Document**: A workspace-scoped knowledge asset with an internal Radioso document ID, content, processing status, optional metadata, and an optional immutable `externalDocumentId` that may map it to a record in another system.
- **External Document Identity**: A tenant-local identifier supplied by an external system and bound to exactly one document within a workspace once set.
- **Workspace**: The tenant boundary that scopes uniqueness, idempotency, and document ownership.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Repeating the same document create request with the same `externalDocumentId` in the same workspace results in one logical document and zero duplicate rows.
- **SC-002**: Two different workspaces can each store the same `externalDocumentId` value without cross-tenant collisions or failed writes.
- **SC-003**: Existing document clients that omit `externalDocumentId` continue to pass their current contract and integration tests without behavioral regression.
- **SC-004**: Attempts to change an already-set `externalDocumentId` are rejected consistently and leave the stored document identity unchanged.

## Assumptions

- The initial scope applies to the existing inline document write contract rather than introducing a new sync-only API surface.
- `externalDocumentId` is a single opaque string supplied by the caller; source-system namespacing is out of scope unless a future feature proves one workspace needs multiple overlapping external identity domains.
- The internal document UUID remains the only identifier used by downstream relational data such as chunks, processing jobs, and existing dashboard deep links.
- Contract and documentation updates are limited to the document API and related operator-facing references affected by this additive field.
