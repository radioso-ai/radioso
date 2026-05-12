# Implementation Plan: Document Search

**Branch**: `026-document-search` | **Date**: 2026-03-25 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/spec.md)
**Input**: Feature specification from `/specs/026-document-search/spec.md`

## Summary

Add a first-class document discovery flow by introducing a dedicated search API that ranks documents from existing retrieval signals, persists each completed search as a replayable snapshot plus retrieval trace in workspace-scoped audit history, exposes history/replay endpoints, and surfaces the same capability in the Documents page through a top-bar search experience with explicit result actions. Preserve plain document browsing at `GET /document/`, keep search orchestration separate from routes and chat services, and reuse the existing `RetrievalTrace` contract and graph UI with search-specific stage participation.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives  
**Storage**: PostgreSQL 16 with `pgvector`; reuse `audit_events.metadata_json` for replayable search history snapshots and traces, no new storage system planned  
**Testing**: Vitest unit, contract, and integration tests under `backend/tests`; frontend state/component verification in the existing frontend approach plus manual dashboard workflow verification  
**Target Platform**: Web application with Node.js backend service and Next.js admin frontend  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Typical live search responses within the current retrieval latency envelope; history list and replay reads should feel near-instant for operator workflows; replay must not rerun retrieval  
**Constraints**: Keep `GET /document/` as plain browse, backend TDD required, bounded snapshot/result payloads only, no hand-edited generated OpenAPI files, preserve workspace scoping, reuse existing `RetrievalTrace` contract, and avoid bloating `documents-view.tsx`  
**Scale/Scope**: Additive backend API/history/trace feature spanning document routes, search orchestration, audit-event persistence, OpenAPI registry, frontend API types, document dashboard state, and diagnostics/history rendering

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved `spec.md` exists in `specs/026-document-search/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks will require backend contract/unit/integration tests before production code changes.
- Stack remains Node.js for backend and React for frontend. Pass: additive TypeScript/Node backend and React/Next frontend work only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no database technology change; existing retrieval and audit-event infrastructure are reused.
- LLM provider is GPT-5.2 for AI integrations. Pass: feature does not change model integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass with explicit design requirement: snapshots and traces remain bounded, workspace-scoped, and exclude full prompts or full document bodies.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with dedicated document-search service and history seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `documentRoutes.ts`, `documents-view.tsx`, and chat history/trace modules remain bounded.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: frontend search state/rendering extraction is planned before wiring the full dashboard experience.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: additive contract updates will be modeled in the code-first registry.

## Project Structure

### Documentation (this feature)

```text
specs/026-document-search/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── document-search-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── openapi/document.ts
│   │   └── routes/documentRoutes.ts
│   ├── db/repositories/
│   │   └── auditEventRepository.ts
│   └── modules/
│       ├── documents/services/
│       │   ├── documentIngestionService.ts
│       │   └── [new document search service / history service modules]
│       ├── retrieval/
│       │   ├── domain/retrievalPipelineTypes.ts
│       │   └── services/
│       │       ├── candidateRetrievalStage.ts
│       │       ├── retrievalPipelineService.ts
│       │       ├── retrievalTraceAssembler.ts
│       │       └── [new search trace assembly helpers]
│       └── chat/services/
│           └── chatHistoryService.ts
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── components/dashboard/
│   ├── documents-view.tsx
│   └── [new document search bar / results / history-trace components]
└── lib/
    └── api.ts
```

**Structure Decision**: Keep transport in `backend/src/app/http/routes/documentRoutes.ts` and the code-first OpenAPI registry, document-search orchestration in new focused services under `backend/src/modules/documents/services/`, trace assembly in retrieval-focused helper modules, and replay persistence in the existing audit-event repository. On the frontend, extract search-specific state and rendering from `frontend/components/dashboard/documents-view.tsx` into focused components/hooks so document CRUD and search/replay flows do not collapse into one file.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/documentRoutes.ts` plus the code-first OpenAPI registry in `backend/src/app/http/openapi/document.ts`.
- **Orchestration Layer**: New document-search services coordinate live search execution, snapshot persistence, and replay reads; existing document ingestion/deletion services remain unchanged in responsibility.
- **Domain Layer**: Retrieval modules remain the source of chunk-level candidate signals and the shared `RetrievalTrace` contract; new search-specific mappers aggregate chunk candidates into ranked document results and search-oriented trace stages.
- **Persistence/Integration Layer**: `backend/src/db/repositories/auditEventRepository.ts` persists and replays `document.search` audit events; existing document and chunk repositories remain the source of live document data.
- **Files Kept Small**: `backend/src/app/http/routes/documentRoutes.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `backend/src/modules/chat/services/chatHistoryService.ts`, and `frontend/components/dashboard/documents-view.tsx` must not absorb ranking, snapshot-formatting, or diagnostics rendering logic.
- **Planned Extractions**:
  - `DocumentSearchService` for live search orchestration
  - `DocumentSearchHistoryService` for listing and replay
  - search snapshot serializer/presenter around audit metadata
  - search-specific retrieval trace assembler/presenter helpers that emit the shared `RetrievalTrace`
  - frontend document-search bar/results/history components or hooks
- **Required Refactor Stories**:
  - Extract frontend search state/result rendering from `documents-view.tsx` before wiring history replay and diagnostics.
  - Add audit-event repository read methods for `document.search` before implementing replay consumers.

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/research.md) for the decisions on API shape, snapshot persistence, replay semantics, trace reuse, dashboard composition, and bounded payload rules.

## Phase 1: Design & Contracts

- The search request, live result, history entry, replay snapshot, and shared-trace usage model are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/data-model.md).
- Design-time contract notes for live search, history list, and replay endpoints are captured in [document-search-contract.md](/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/contracts/document-search-contract.md).
- Implementation and verification flow is captured in [quickstart.md](/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/quickstart.md).
- Backend HTTP contract ownership remains in `backend/src/app/http/openapi/document.ts`; generated `backend/openapi.yaml` and `backend/openapi.json` will be regenerated from code, never edited directly.

## Post-Design Constitution Check

- Backend TDD remains required and will be enforced in tasks before backend code changes.
- No stack or storage-system changes are introduced; the design reuses PostgreSQL, pgvector retrieval, and audit-event metadata.
- Customer-data protections remain explicit through bounded search snapshots and shared-trace payload rules that exclude secrets, full prompts, and full raw document bodies.
- Ownership seams are explicit across routes, search orchestration, retrieval aggregation, audit-event replay, OpenAPI schemas, and frontend document-search presentation.
- Existing responsibility-limited files stay transport-only or presentation-only, with planned extractions handling new search concerns.
- No constitution violations or exceptions are required for this feature.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
