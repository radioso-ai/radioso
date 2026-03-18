# Tasks: Document Metadata

**Input**: Design documents from `/specs/015-document-metadata/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED per constitution (TDD). Tests MUST be written and fail before implementation.

**Organization**: Tasks grouped by user story. US1 (store + propagate metadata) and US2 (metadata in retrieval context) are both P1 and tightly coupled — they form the MVP together. US3 (filter by metadata) is P2.

**Architecture**: No new services or modules. Metadata flows through existing document → chunk → retrieval layers as an additive JSONB field.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Web app**: `backend/src/`, `frontend/`

---

## Phase 1: Setup

**Purpose**: Database migration

- [ ] T001 Write migration `backend/src/db/migrations/006_document_metadata.sql` — add `metadata JSONB NOT NULL DEFAULT '{}'` to `documents` and `chunks` tables, create GIN indexes `idx_documents_metadata` and `idx_chunks_metadata`. Must be fully idempotent.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Type and repository changes that all user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

- [ ] T002 [P] Write contract test for document metadata in `backend/tests/contract/document.contract.test.ts` — test POST with metadata returns 202, GET returns metadata, POST without metadata works with empty object
- [ ] T003 [P] Write integration test for metadata propagation in `backend/tests/integration/document-chunking.integration.test.ts` — test that chunks created from a document with metadata carry that metadata

### Implementation for Foundational

- [ ] T004 [P] Update `DocumentRecord` type and `DocumentRepository` in `backend/src/db/repositories/documentRepository.ts` — add `metadata: Record<string, unknown>` to DocumentRecord, include `metadata` in INSERT/SELECT queries, default to `'{}'`
- [ ] T005 [P] Update `ChunkRecord` type and `ChunkRepository` in `backend/src/db/repositories/chunkRepository.ts` — add `metadata: Record<string, unknown>` to ChunkRecord, include `metadata` in INSERT queries and all SELECT queries
- [ ] T006 [P] Update in-memory fakes in `backend/tests/support/fakes.ts` — add `metadata` field to fake DocumentRepository and ChunkRepository implementations

**Checkpoint**: Types and persistence layer support metadata. Tests fail (no route/service changes yet).

---

## Phase 3: User Story 1 — Store and Propagate Metadata (Priority: P1) — MVP

**Goal**: Users can attach metadata when uploading documents. Metadata is stored and propagated to chunks during ingestion.

**Independent Test**: POST a document with metadata, GET it back and verify metadata is present. Wait for processing, verify chunks carry the metadata.

### Tests for User Story 1

- [ ] T007 [P] [US1] Write unit test for metadata propagation in `backend/tests/unit/document-ingestion.test.ts` — test that DocumentProcessingService copies document metadata to each ChunkRecord

### Implementation for User Story 1

- [ ] T008 [US1] Update Zod schema and route handler in `backend/src/app/http/routes/documentRoutes.ts` — add optional `metadata` field to `documentSchema` (z.record with 16 KB size validation), pass metadata to ingestion service, include metadata in GET responses
- [ ] T009 [US1] Update `DocumentIngestionService` in `backend/src/modules/documents/services/documentIngestionService.ts` — accept `metadata` parameter in `ingest()` and `update()` port methods, pass to repository
- [ ] T010 [US1] Update `DocumentProcessingService` in `backend/src/modules/documents/services/documentProcessingService.ts` — read document metadata when processing, copy to each ChunkRecord during enrichment
- [ ] T011 [US1] Update `backend/openapi.yaml` — add `metadata` field to DocumentCreateRequest, DocumentSummary, and DocumentDetails schemas

**Checkpoint**: Documents accept and return metadata. Chunks carry propagated metadata. Contract and integration tests pass.

---

## Phase 4: User Story 2 — Metadata in Retrieval Context (Priority: P1)

**Goal**: Chunk metadata is included in retrieval results and available in the LLM prompt.

**Independent Test**: Upload a document with `sourceUrl` metadata, ask a question, verify the prompt context includes the metadata.

### Tests for User Story 2

- [ ] T012 [P] [US2] Write unit test for metadata in retrieval in `backend/tests/unit/chat-retrieval.domain.test.ts` — test that prompt builder renders metadata when present on chunks

### Implementation for User Story 2

- [ ] T013 [P] [US2] Update `RetrievedChunk` type in `backend/src/modules/retrieval/infra/vectorSearch.ts` — add `metadata?: Record<string, unknown>` to RetrievedChunk interface, include `c.metadata` in vector search SELECT query
- [ ] T014 [P] [US2] Update lexical search in `backend/src/modules/retrieval/infra/lexicalSearch.ts` — include `c.metadata` in lexical search SELECT query, map to RetrievedChunk
- [ ] T015 [US2] Update `PromptBuilder` in `backend/src/modules/retrieval/services/promptBuilder.ts` — render chunk metadata (e.g., "Source: {sourceUrl}") in prompt context when present

**Checkpoint**: Retrieval results include chunk metadata. LLM can cite source URLs. Chat retrieval tests pass.

---

## Phase 5: User Story 3 — Filter Retrieval by Metadata (Priority: P2)

**Goal**: Users can constrain retrieval to chunks matching specific metadata key-value pairs.

**Independent Test**: Upload two documents with different `language` metadata, send a chat message with `metadataFilter: { "language": "en" }`, verify only English chunks are retrieved.

### Tests for User Story 3

- [ ] T016 [P] [US3] Write integration test for metadata filtering in `backend/tests/integration/chat.integration.test.ts` — test that metadataFilter in chat request restricts retrieval to matching chunks

### Implementation for User Story 3

- [ ] T017 [P] [US3] Add metadata filter to vector search in `backend/src/modules/retrieval/infra/vectorSearch.ts` — accept optional `metadataFilter` param, add `AND c.metadata @> $N::jsonb` WHERE clause when provided
- [ ] T018 [P] [US3] Add metadata filter to lexical search in `backend/src/modules/retrieval/infra/lexicalSearch.ts` — same `@>` containment filter
- [ ] T019 [US3] Pass metadataFilter through retrieval pipeline in `backend/src/modules/retrieval/services/retrievalPipelineService.ts` — accept `metadataFilter` in `run()` input, pass to vector and lexical search calls
- [ ] T020 [US3] Pass metadataFilter through chat service in `backend/src/modules/chat/services/chatService.ts` — accept `metadataFilter` in chat input, pass to retrieval pipeline
- [ ] T021 [US3] Accept metadataFilter in chat routes in `backend/src/app/http/routes/chatRoutes.ts` — add optional `metadataFilter` to chat message Zod schema, pass to chatService
- [ ] T022 [US3] Update `backend/openapi.yaml` — add `metadataFilter` field to ChatMessageRequest schema

**Checkpoint**: Metadata filtering works end-to-end. Chat integration tests pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup and validation

- [ ] T023 [P] Update test fakes in `backend/tests/support/testApp.ts` — ensure issueTestToken and test helpers handle metadata field correctly
- [ ] T024 Run full quickstart.md verification scenario end-to-end
- [ ] T025 Verify all existing tests pass with no regressions

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 (migration must exist for repository changes)
- **Phase 3 (US1)**: Depends on Phase 2 — repositories must support metadata
- **Phase 4 (US2)**: Depends on Phase 2 — chunks must carry metadata. Can run in parallel with US1 if chunks are manually seeded in tests.
- **Phase 5 (US3)**: Depends on Phase 4 — search must return metadata before filtering makes sense
- **Phase 6 (Polish)**: Depends on Phases 3-5

### User Story Dependencies

- **US1 (Store + Propagate)**: After Phase 2. Independent.
- **US2 (Retrieval Context)**: After Phase 2. Independent of US1 for implementation, but end-to-end testing needs US1 complete.
- **US3 (Filter)**: After US2 (needs search queries modified before adding filter).

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Repositories before services
- Services before routes
- Backend before frontend (no frontend changes in this feature)

### Parallel Opportunities

- T002, T003 (foundational tests) — parallel
- T004, T005, T006 (repository + fakes updates) — parallel
- T013, T014 (vector + lexical search updates) — parallel
- T017, T018 (vector + lexical filter additions) — parallel

---

## Implementation Strategy

### MVP (Phase 1 + 2 + 3 + 4)

US1 and US2 are tightly coupled P1 stories forming the minimum viable feature:
1. Phase 1: Migration
2. Phase 2: Repository + type changes
3. Phase 3: Store and propagate metadata (US1)
4. Phase 4: Metadata in retrieval context (US2)
5. **STOP and VALIDATE**: Documents carry metadata, retrieval includes it in prompts

### Incremental Delivery

1. MVP (above) → core metadata flow working
2. Phase 5 (US3) → metadata filtering adds precision
3. Phase 6 → polish and validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Total: 25 tasks across 6 phases
- No new services or modules — purely additive fields through existing layers
- Key risk: ensuring metadata propagation in DocumentProcessingService doesn't regress chunking
