# Implementation Plan: Document Metadata

**Branch**: `015-document-metadata` | **Date**: 2026-03-18 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/015-document-metadata/spec.md`

## Summary

Add optional JSONB metadata to documents and chunks. Metadata is accepted at document creation, propagated to chunks during ingestion, included in retrieval context for LLM prompt building, and usable as a pre-filter on retrieval queries.

## Technical Context

**Language/Version**: TypeScript / Node.js 22
**Primary Dependencies**: Express, Zod, pg (node-postgres)
**Storage**: PostgreSQL 16 with pgvector — JSONB columns with GIN indexes
**Testing**: Vitest (unit, integration, contract)
**Target Platform**: Linux server (Docker)
**Project Type**: Web application (backend + frontend)
**Performance Goals**: No measurable regression on existing queries; GIN index keeps metadata filtering efficient
**Constraints**: Metadata size capped at 16 KB per document
**Scale/Scope**: Additive change — touches ~10 files, no new services

## Constitution Check

- [x] Spec exists and is approved; no implementation without spec.
- [x] Backend work includes TDD with failing tests written before implementation.
- [x] Stack remains Node.js for backend and React for frontend.
- [x] Database is PostgreSQL with pgvector for embeddings and vector search.
- [x] LLM provider is GPT-5.2 for AI integrations — not affected by this feature.
- [x] Secrets and keys are managed via `.env` — no new secrets needed.
- [x] Customer data handling — metadata is user-supplied, stored alongside existing document data, same access controls apply.
- [x] Module boundaries — metadata flows through existing layers without new services.
- [x] Existing files remain responsibility-limited — no file absorbs new concerns outside its layer.
- [x] No refactor stories needed — affected files are appropriately sized.

## Project Structure

### Documentation (this feature)

```text
specs/015-document-metadata/
├── plan.md              # This file
├── research.md          # Storage approach, propagation, filtering decisions
├── data-model.md        # Schema changes, type updates, migration SQL
├── quickstart.md        # End-to-end verification scenario
├── contracts/           # API contract changes
└── tasks.md             # Implementation tasks (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── db/
│   │   ├── migrations/006_document_metadata.sql        # NEW: add metadata columns + GIN indexes
│   │   └── repositories/
│   │       ├── documentRepository.ts                    # MODIFY: add metadata to queries
│   │       └── chunkRepository.ts                       # MODIFY: add metadata to queries
│   ├── app/http/routes/
│   │   ├── documentRoutes.ts                            # MODIFY: Zod schema + response mapping
│   │   └── chatRoutes.ts                                # MODIFY: pass metadataFilter
│   ├── modules/
│   │   ├── documents/services/
│   │   │   ├── documentIngestionService.ts              # MODIFY: accept metadata param
│   │   │   └── documentProcessingService.ts             # MODIFY: propagate metadata to chunks
│   │   ├── chat/services/chatService.ts                 # MODIFY: pass metadataFilter through
│   │   └── retrieval/
│   │       ├── infra/vectorSearch.ts                    # MODIFY: optional metadata filter in query
│   │       ├── infra/lexicalSearch.ts                   # MODIFY: optional metadata filter in query
│   │       └── services/
│   │           ├── retrievalPipelineService.ts           # MODIFY: accept + pass metadataFilter
│   │           └── promptBuilder.ts                      # MODIFY: render metadata in prompt context
├── tests/
│   ├── contract/document.contract.test.ts               # MODIFY: test metadata in request/response
│   ├── integration/
│   │   ├── document-chunking.integration.test.ts        # MODIFY: verify metadata propagation
│   │   └── chat.integration.test.ts                     # MODIFY: test metadataFilter
│   └── unit/
│       └── document-ingestion.test.ts                   # MODIFY: test metadata flow
└── openapi.yaml                                         # MODIFY: add metadata schemas
```

**Structure Decision**: No new files except the migration. Metadata is a property that flows through existing document → chunk → retrieval layers. Each layer adds one field to its existing types and queries.

## Module Ownership & Seams

- **Transport Layer**: `documentRoutes.ts` — validates metadata via Zod, maps to/from response. `chatRoutes.ts` — passes metadataFilter from request body.
- **Orchestration Layer**: `documentIngestionService.ts` — passes metadata to repository. `chatService.ts` — passes metadataFilter to retrieval pipeline.
- **Domain Layer**: `documentProcessingService.ts` — copies document metadata to each chunk during enrichment. `promptBuilder.ts` — renders metadata in prompt context.
- **Persistence/Integration Layer**: `documentRepository.ts`, `chunkRepository.ts` — store/retrieve metadata JSONB. `vectorSearch.ts`, `lexicalSearch.ts` — apply optional `@>` filter.
- **Files Kept Small**: `chatService.ts` passes metadataFilter through without processing it. `documentRoutes.ts` only adds Zod validation, no business logic.
- **Planned Extractions**: None needed — metadata is a simple additive property.
- **Required Refactor Stories**: None — all affected files are appropriately sized.

## Complexity Tracking

No constitution violations. No complexity justifications needed.
