# Implementation Plan: Universal Retrieval Quality Upgrade

**Branch**: `002-improve-rag-pipeline` | **Date**: 2026-03-13 | **Spec**: [/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/spec.md](/private/tmp/hivec-improve-rag-pipeline/specs/002-improve-rag-pipeline/spec.md)
**Input**: Feature specification from `/specs/002-improve-rag-pipeline/spec.md`

## Summary

Upgrade the retrieval pipeline so grounded chat remains reliable across strict, moderate, and broad retrieval profiles without changing the public HTTP contract. The plan replaces heuristic query concatenation and keyword reranking with model-assisted retrieval preparation, normalized candidate assembly, semantic reranking, and final context selection bounded by answer context budget. Existing chat orchestration remains responsible for conversation flow only, while retrieval-specific decisions stay inside focused retrieval services.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, OpenAI SDK, `pg`, `pgvector`, Zod, Pino  
**Storage**: PostgreSQL 16+ with `pgvector`; filesystem-backed feature artifacts under `/specs/002-improve-rag-pipeline/`  
**Testing**: Vitest, Supertest, integration tests against the backend app, persistence validation against PostgreSQL  
**Target Platform**: Dockerized backend service and local development on macOS/Linux  
**Project Type**: Web application with a Node.js backend and separate frontend workspace; this feature is backend-only  
**Performance Goals**: Preserve grounded-answer success metrics from the approved spec while keeping non-streaming chat within the existing backend latency expectations and adding no more than the minimum necessary retrieval-assist model calls per request  
**Constraints**: No public API contract changes, preserve account scoping, maintain safe fallback behavior, keep GPT-5.2 as the default LLM provider, keep secrets in `.env`, preserve modular boundaries between routes, orchestration, retrieval domain logic, and persistence  
**Scale/Scope**: Account-scoped document retrieval over representative corpora with candidate depths in the low hundreds and final answer contexts constrained by prompt budget rather than raw retrieval depth alone

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. PASS
- Backend work includes TDD with failing tests written before implementation. PASS
- Stack remains Node.js for backend and React for frontend. PASS
- Database is PostgreSQL with `pgvector` for embeddings and vector search. PASS
- LLM provider is GPT-5.2 for AI integrations. PASS
- Secrets and keys are managed via `.env` and `.env.example` is updated. PASS
- Customer data handling and auditability are addressed where applicable. PASS
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. PASS
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. PASS
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. PASS

## Project Structure

### Documentation (this feature)

```text
specs/002-improve-rag-pipeline/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── openapi.yaml
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
│   │   ├── chat/services/
│   │   ├── documents/services/
│   │   ├── retrieval/
│   │   │   ├── domain/
│   │   │   ├── infra/
│   │   │   └── services/
│   │   └── settings/
│   └── shared/
│       ├── infra/
│       └── observability/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
└── [unchanged for this feature]
```

**Structure Decision**: Keep all feature changes inside the existing backend retrieval, chat, document-ingestion, and observability modules. `backend/src/app/http/routes/*.ts` remain transport-only. `backend/src/modules/chat/services/chatService.ts` remains orchestration-only for conversation lifecycle and answer dispatch. Retrieval decision-making stays in `backend/src/modules/retrieval/`. Repository and OpenAI client concerns remain in `backend/src/db/repositories/` and `backend/src/shared/infra/`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, request validation middleware
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- **Domain Layer**: retrieval query rewrite policy, conversation-context selection, candidate normalization, semantic reranking, prompt context budgeting, prompt construction
- **Persistence/Integration Layer**: `backend/src/db/repositories/*`, `backend/src/modules/retrieval/infra/vectorSearch.ts`, `backend/src/shared/infra/openaiClient.ts`, OpenAI-backed gateways for rewrite/rerank/answer generation
- **Files Kept Small**: `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/infra/vectorSearch.ts`
- **Planned Extractions**: conversation-context selector, retrieval-query rewrite gateway, candidate assembly/normalization service, semantic rerank gateway, prompt-context budget selector, retrieval execution telemetry mapper
- **Required Refactor Stories**: split `backend/src/modules/retrieval/services/retrievalPipelineService.ts` into an orchestration-only coordinator plus focused retrieval services before layering the stronger rewrite/rerank behavior into that file

## Complexity Tracking

No constitution violations expected.
