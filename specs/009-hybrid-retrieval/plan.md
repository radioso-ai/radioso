# Implementation Plan: Hybrid Retrieval

**Branch**: `009-hybrid-retrieval` | **Date**: 2026-03-14 | **Spec**: [/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/spec.md](/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/spec.md)
**Input**: Feature specification from `/specs/009-hybrid-retrieval/spec.md`

## Summary

Add true hybrid retrieval to Hivec by combining the existing pgvector search path with PostgreSQL full-text lexical search, richer chunk `searchText`, deterministic structured attribute extraction for a bounded first set of attribute families, account-scoped controls for how those families participate in retrieval, and an operator-facing retrieval-information view. The design keeps routing and chat orchestration thin by introducing focused retrieval-domain seams for lexical candidate generation, query constraint parsing, attribute extraction and normalization, attribute-aware candidate scoring, and retrieval-information presentation.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, existing audit service, PostgreSQL full-text search functions, existing embedding and rerank services  
**Storage**: PostgreSQL `chunks`, `retrieval_settings`, `documents`, `messages`, and `audit_events`; additive chunk-search and retrieval-settings columns only, no new external storage system  
**Testing**: Vitest + Supertest for backend TDD; existing contract, integration, benchmark, and unit suites plus targeted frontend verification  
**Target Platform**: Web application with browser admin UI and Node.js API  
**Project Type**: web application  
**Performance Goals**: Keep candidate generation bounded to semantic `topK` 40, lexical `topK` 20, merged candidate cap 50, preserve current chat responsiveness for representative account corpora, and keep retrieval-information rendering lightweight  
**Constraints**: Preserve existing chat and citation behavior apart from additive retrieval metadata, keep custom user-defined schemas out of scope, prefer PostgreSQL-native lexical search in the first release, use conservative confidence thresholds for hard filters, and keep all retrieval controls account-scoped  
**Scale/Scope**: One retrieval pipeline, one document-ingestion flow, one retrieval-settings surface, one chat response contract, one admin retrieval-information surface, and benchmark coverage for exact-match, mixed-signal, fallback, and constraint-heavy queries

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; the plan starts with failing backend tests for lexical retrieval, normalization, query parsing, candidate merge logic, retrieval settings, and retrieval diagnostics before implementation.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; lexical retrieval is added with PostgreSQL full-text search, not a replacement storage system.
- LLM provider is GPT-5.2 for AI integrations. Pass; embeddings and reranking stay on existing provider seams.
- Secrets and keys are managed via `.env` and `.env.example` are updated. Pass; no new secrets are expected.
- Customer data handling and auditability are addressed where applicable. Pass; retrieval controls remain account-scoped and diagnostics continue through audited chat and settings flows.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; the plan adds focused retrieval modules instead of growing route handlers, `ChatService`, or `DocumentIngestionService` into god objects.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; retrieval-domain extractions are required before hybrid logic expands the current pipeline and settings flow further.

## Project Structure

### Documentation (this feature)

```text
specs/009-hybrid-retrieval/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── hybrid-retrieval.openapi.yaml
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── http/
│   │   │   ├── presenters/
│   │   │   └── routes/
│   │   └── server/
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   └── modules/
│       ├── audit/services/
│       ├── chat/services/
│       ├── documents/services/
│       ├── retrieval/
│       │   ├── domain/
│       │   ├── infra/
│       │   └── services/
│       └── settings/
│           ├── domain/
│           └── services/
└── tests/
    ├── contract/
    ├── fixtures/
    ├── integration/
    ├── support/
    └── unit/

frontend/
├── app/
│   └── api/chat/stream/
├── components/
│   ├── dashboard/
│   └── ui/
└── lib/
```

**Structure Decision**: This feature stays inside the existing web-app split. Transport ownership remains in `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, and `backend/src/app/http/presenters/chatPresenter.ts`; orchestration remains in `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `backend/src/modules/documents/services/documentIngestionService.ts`, and `backend/src/modules/settings/services/retrievalSettingsService.ts`; domain retrieval behavior expands through focused modules under `backend/src/modules/retrieval/`; persistence remains in `backend/src/db/repositories/*` plus additive migrations; frontend ownership stays in `frontend/lib/api.ts`, `frontend/lib/chat-context.tsx`, `frontend/components/dashboard/settings-view.tsx`, and `frontend/components/dashboard/chat-view.tsx`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/presenters/chatPresenter.ts`, `frontend/app/api/chat/stream/route.ts`
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `backend/src/modules/documents/services/documentIngestionService.ts`, `backend/src/modules/settings/services/retrievalSettingsService.ts`
- **Domain Layer**: new search-text rendering, deterministic attribute extraction and normalization, supported query-constraint parsing, hybrid candidate merge and scoring, retrieval-information shaping, and lexical-search request modeling under `backend/src/modules/retrieval/domain/` and `backend/src/modules/retrieval/services/`
- **Persistence/Integration Layer**: `backend/src/modules/retrieval/infra/vectorSearch.ts`, new lexical-search infra module, `backend/src/db/repositories/chunkRepository.ts`, `backend/src/db/repositories/retrievalSettingsRepository.ts`, additive migrations, existing OpenAI embedding and rerank gateways
- **Frontend Ownership**: `frontend/lib/api.ts`, `frontend/lib/chat-context.tsx`, `frontend/components/dashboard/settings-view.tsx`, `frontend/components/dashboard/chat-view.tsx`
- **Files Kept Small**: `chatRoutes.ts`, `chatService.ts`, `retrievalPipelineService.ts`, `documentIngestionService.ts`, `settings-view.tsx`, `chat-view.tsx`
- **Planned Extractions**: `LexicalSearchPort`, `SearchTextRenderer`, `StructuredAttributeExtractor`, `AttributeNormalizer`, `QueryConstraintParser`, `HybridCandidateMergeService`, `AttributeMatchScoringService`, `RetrievalInfoPresenter`, and focused retrieval-settings types for attribute-family controls
- **Required Refactor Stories**: split the current candidate-preparation and retrieval-telemetry expansion into focused retrieval modules before layering in lexical scores, attribute payloads, and retrieval-info responses

## Phase 0: Research Decisions

- Use PostgreSQL full-text search over normalized chunk `search_text` for the lexical retrieval leg in the first release.
- Persist hybrid-ingest metadata on `chunks` through additive fields for normalized `search_text` and a normalized structured-attribute payload instead of introducing a separate search index service.
- Apply supported attribute filtering and boosting in application-layer retrieval services after bounded semantic and lexical candidate generation, keeping SQL focused on candidate lookup rather than complex per-request ranking heuristics.
- Model supported attribute families through account-scoped retrieval settings controls that capture `enabled` and `mode` (`boost_only` or `hard_filter`) per family.
- Expose operator-facing retrieval information through additive chat response metadata and matching frontend view-model wiring instead of requiring the UI to query raw audit logs.
- Keep the first release bounded to date points, date ranges, money values, and locations, with conservative confidence thresholds required before hard filtering is allowed.

## Phase 1: Design Outputs

- `research.md` captures decisions for lexical retrieval, chunk metadata storage, app-layer attribute scoring, retrieval-info exposure, supported normalization rules, and bounded operator controls.
- `data-model.md` defines retrieval settings additions, chunk search text, normalized attribute payloads, parsed query constraints, hybrid candidates, and retrieval-information view data.
- `contracts/hybrid-retrieval.openapi.yaml` defines additive retrieval-settings controls and chat response payload additions for retrieval information.
- `quickstart.md` captures the TDD-first implementation and verification path across backend, frontend, and benchmark coverage.

## Implementation Strategy

1. Extend retrieval-settings domain, persistence, transport, and frontend types to support account-scoped attribute-family controls and safe defaults.
2. Add ingest-time `search_text` rendering plus deterministic attribute extraction and normalization, and persist those results on chunk records with the required database indexes.
3. Add PostgreSQL lexical candidate generation and a focused hybrid candidate merge path that deduplicates by chunk id, retains source provenance, and caps merged candidates before attribute-aware adjustments.
4. Add supported query-constraint parsing plus attribute-aware hard-filter or boost logic with explicit confidence thresholds and recall-safe fallback behavior.
5. Expand rerank inputs and prompt-context assembly to use enriched retrieval text and relevant supported attributes while preserving current citation behavior.
6. Expose bounded retrieval information through chat responses and streaming completion payloads, then render it in the admin chat experience without turning the UI into a raw log viewer.
7. Cover the work with backend-first TDD, contract and benchmark updates, and targeted frontend verification for settings and retrieval-information presentation.

## Testing Strategy

- Backend unit tests for retrieval-settings validation, defaults, and account-scoped attribute-family controls
- Backend unit tests for search-text rendering and normalization behavior
- Backend unit tests for deterministic supported attribute extraction and normalization across date points, date ranges, money values, and locations
- Backend unit tests for supported query-constraint parsing, confidence thresholds, and hard-filter versus boost-only degradation rules
- Backend unit tests for lexical search candidate mapping, hybrid candidate merge behavior, deduplication by chunk id, and attribute-aware scoring
- Backend unit tests for retrieval-information shaping and chat-payload presentation
- Backend contract tests for retrieval-settings payload changes and additive chat response retrieval-info fields
- Backend integration and benchmark tests for exact-match, mixed-signal, constraint-heavy, fallback, and no-context scenarios
- Targeted frontend verification for attribute-family controls in Settings and retrieval-information rendering in the chat admin experience

## Post-Design Constitution Check

- Spec-first gate remains satisfied. Pass.
- Backend TDD scope is explicit and front-loaded. Pass.
- Stack discipline remains unchanged; PostgreSQL and pgvector stay primary. Pass.
- No new secret or provider changes are introduced. Pass.
- Customer data remains account-scoped, retrieval diagnostics stay bounded, and auditability is preserved. Pass.
- Transport, orchestration, domain, persistence, and frontend ownership boundaries remain explicit. Pass.
- No constitution violations require justification.

## Complexity Tracking

No constitution exceptions or justified violations are required for this plan.
