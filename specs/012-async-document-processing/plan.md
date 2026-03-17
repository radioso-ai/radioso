# Implementation Plan: Async Document Processing

**Branch**: `012-async-document-processing` | **Date**: 2026-03-16 | **Spec**: [/Users/dm/code/hivec-async-document-processing/specs/012-async-document-processing/spec.md](/Users/dm/code/hivec-async-document-processing/specs/012-async-document-processing/spec.md)
**Input**: Feature specification from `/specs/012-async-document-processing/spec.md`

## Summary

Move document create and update flows from synchronous ingestion to a durable PostgreSQL-backed background processing model. Request-time orchestration will persist the latest accepted document revision and enqueue processing work immediately. A background worker will claim queued jobs, compute chunks and embeddings, publish retrieval content only when the job still matches the latest revision, and update document status to `ready` or `failed`. The frontend will show distinct queued, processing, ready, and failed states and refresh non-final documents without blocking the operator.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Vitest, Supertest, Next.js App Router  
**Storage**: PostgreSQL 16+ with `pgvector`; additive job/revision columns and processing-job table  
**Testing**: Vitest unit, contract, integration, and persistence tests; frontend lint validation  
**Target Platform**: Server-rendered web app with Node.js backend and browser-based admin UI  
**Project Type**: Web application with `backend/` and `frontend/`  
**Performance Goals**: 95% of document create/update requests accepted in under 3 seconds; background processing durable across restart  
**Constraints**: Preserve account scoping and auditability, keep routes transport-only, avoid in-memory queue durability assumptions, keep retrieval limited to ready documents, follow backend TDD  
**Scale/Scope**: Single-repo feature touching document ingestion, persistence, worker orchestration, contracts, and document UI status handling

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated only if new configuration is introduced.
- Customer data handling and auditability are addressed through account-scoped jobs, document status tracking, and audit events.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit in this plan.
- Existing responsibility-limited files are identified, and the plan avoids pushing worker or queue logic into route handlers.
- The current document ingestion service is already broad enough to justify extraction before feature behavior lands there.

## Project Structure

### Documentation (this feature)

```text
specs/012-async-document-processing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── document-processing.openapi.yaml
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── http/routes/
│   │   └── server/
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   ├── modules/
│   │   ├── documents/services/
│   │   └── retrieval/services/
│   └── shared/
└── tests/
    ├── contract/
    ├── integration/
    ├── support/
    └── unit/

frontend/
├── components/dashboard/
└── lib/
```

**Structure Decision**: Keep HTTP routes under `backend/src/app/http/routes/` transport-only. Keep request-time document orchestration in `backend/src/modules/documents/services/` as a focused command/query service. Introduce a dedicated background processing worker and a processing-job repository rather than expanding the existing ingestion flow. Keep PostgreSQL repository concerns inside `backend/src/db/repositories/`. Restrict frontend behavior changes to the document API client and dashboard document views.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/documentRoutes.ts` and route wiring only parse requests, enforce auth, and serialize responses.
- **Orchestration Layer**: `backend/src/modules/documents/services/documentIngestionService.ts` becomes request-time command/query orchestration only, plus a separate worker coordinator that schedules durable background work.
- **Domain Layer**: New focused document processing logic owns chunking, embedding, revision-safety checks, retry decisions, and publish-or-skip rules for processed content.
- **Persistence/Integration Layer**: `backend/src/db/repositories/documentRepository.ts`, a new processing-job repository, and `backend/src/db/repositories/chunkRepository.ts` own database writes; OpenAI embeddings stay behind the existing embedding gateway.
- **Files Kept Small**: `backend/src/app/http/routes/documentRoutes.ts`, `backend/src/app/server/dependencies.ts`, and the frontend dashboard components must not absorb queue or worker decision logic.
- **Planned Extractions**: Add a processing-job repository, a document processing service, a background worker, and revision-aware repository methods for document status publication.
- **Required Refactor Stories**: Extract heavy processing out of the current ingestion service before landing async request behavior so request-time and background-time responsibilities stay separate.

## Phase 0: Research

Research decisions are captured in [research.md](/Users/dm/code/hivec-async-document-processing/specs/012-async-document-processing/research.md).

## Phase 1: Design & Contracts

Design artifacts are captured in:

- [data-model.md](/Users/dm/code/hivec-async-document-processing/specs/012-async-document-processing/data-model.md)
- [quickstart.md](/Users/dm/code/hivec-async-document-processing/specs/012-async-document-processing/quickstart.md)
- [document-processing.openapi.yaml](/Users/dm/code/hivec-async-document-processing/specs/012-async-document-processing/contracts/document-processing.openapi.yaml)

## Complexity Tracking

No constitution violations are required for this feature.
