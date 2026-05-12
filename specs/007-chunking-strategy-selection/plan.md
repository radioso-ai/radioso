# Implementation Plan: Selectable Chunking Strategies

**Branch**: `codex/007-chunking-strategy-selection` | **Date**: 2026-03-14 | **Spec**: [/tmp/radioso-chunking-strategy-selection/specs/007-chunking-strategy-selection/spec.md](/tmp/radioso-chunking-strategy-selection/specs/007-chunking-strategy-selection/spec.md)
**Input**: Feature specification from `/specs/007-chunking-strategy-selection/spec.md`

## Summary

Add an account-scoped chunking strategy selector to retrieval settings, keep fixed-window chunking as the default implementation, and introduce a structure-aware chunking path that parses deterministic document blocks before applying adjacent semantic merging with a structure-only fallback. The design keeps settings, ingestion orchestration, chunking domain logic, and persistence clearly separated so new strategies can be added without growing route handlers or the existing ingestion service into god objects.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, existing embedding service and test support utilities  
**Storage**: PostgreSQL `retrieval_settings` plus existing `documents` and `chunks` tables; no new top-level storage system  
**Testing**: Vitest + Supertest for backend TDD; existing contract, integration, and unit test suites plus targeted frontend settings verification  
**Target Platform**: Web application with browser client and Node.js API  
**Project Type**: web application  
**Performance Goals**: Keep document ingest responsive for current expected account document volumes, preserve current fixed-window ingest behavior, and keep structure-aware chunking bounded so no chunk exceeds configured limits  
**Constraints**: Fixed-window must remain available, no English-specific regex rules, chunking strategy remains account-scoped, existing document API contracts stay stable, and advanced chunking tuning controls stay out of scope for this feature  
**Scale/Scope**: One settings surface, one account-scoped settings model, one document-ingestion orchestration path, and two chunking strategies behind one shared domain interface

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; backend behavior changes cover settings validation, strategy resolution, structured chunking, and ingest wiring with required test-first coverage.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; persistence changes are additive to the existing retrieval settings shape.
- LLM provider is GPT-5.2 for AI integrations. Pass; the structured strategy may use the existing embedding path without changing providers.
- Secrets and keys are managed via `.env` and `.env.example` are updated. Pass; no new secret is expected.
- Customer data handling and auditability are addressed where applicable. Pass; behavior remains account-scoped and settings changes continue through the existing audited settings path.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; the plan introduces a chunking strategy seam rather than branching through route or persistence code.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; chunking logic is extracted from the current single-file helper into focused domain modules before strategy wiring expands further.

## Project Structure

### Documentation (this feature)

```text
specs/007-chunking-strategy-selection/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chunking-strategy-settings.openapi.yaml
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/routes/
│   ├── app/server/
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   └── modules/
│       ├── documents/services/
│       ├── retrieval/
│       │   ├── domain/
│       │   └── services/
│       └── settings/
└── tests/
    ├── contract/
    ├── integration/
    ├── support/
    └── unit/

frontend/
├── app/
├── components/dashboard/
├── components/ui/
└── lib/
```

**Structure Decision**: This feature stays inside the existing web app split. Transport ownership remains in `backend/src/app/http/routes/settingsRoutes.ts` and existing document routes, orchestration remains in `backend/src/modules/documents/services/documentIngestionService.ts` and `backend/src/modules/settings/services/retrievalSettingsService.ts`, domain chunking behavior moves into focused modules under `backend/src/modules/retrieval/domain/`, persistence remains in `backend/src/db/repositories/retrievalSettingsRepository.ts`, migrations, and the existing chunk repository, dependency wiring remains in `backend/src/app/server/dependencies.ts`, API typing remains in `frontend/lib/api.ts`, and the operator-facing selector stays in `frontend/components/dashboard/settings-view.tsx`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts`, existing document routes, response validation/presentation
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts`, `backend/src/modules/documents/services/documentIngestionService.ts`
- **Domain Layer**: current `backend/src/modules/retrieval/domain/chunkingService.ts` evolves into focused chunking strategy modules, including a shared strategy interface, fixed-window implementation, structure-aware block parser, adjacent-merge planner, and bounded fallback behavior
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts`, `backend/src/db/migrations/*`, `backend/src/db/repositories/chunkRepository.ts`, existing embedding gateway/service
- **Frontend Ownership**: `frontend/lib/api.ts`, `frontend/components/dashboard/settings-view.tsx`
- **Files Kept Small**: `settingsRoutes.ts`, `documentIngestionService.ts`, `retrievalSettingsRepository.ts`, `frontend/components/dashboard/settings-view.tsx`
- **Planned Extractions**: chunking strategy types, chunking strategy registry or resolver, fixed-window strategy module, structured block parser, structured merge planner, and any narrow similarity port needed by the structure-aware strategy
- **Required Refactor Stories**: extract the current direct chunking helper into focused domain modules before adding the structured strategy and strategy selection wiring

## Phase 0: Research Decisions

- Store `chunkingStrategy` in the existing retrieval settings model and transport seam.
- Use a shared chunking strategy interface and registry rather than a monolithic chunking function with mode flags.
- Model structure-aware chunking as deterministic block parsing plus adjacent semantic merging.
- When semantic similarity is unavailable, fall back within the structured strategy to deterministic structure-only chunk assembly.
- Keep operator-facing settings limited to one strategy selector in this feature.
- Preserve document create and update API shapes; strategy selection remains account-scoped rather than per-request.

## Phase 1: Design Outputs

- `research.md` captures storage, strategy seam, structured strategy behavior, fallback, scope, and testing decisions.
- `data-model.md` defines the retrieval settings addition, supported strategy ids, structural block units, boundary decisions, and persisted chunk implications.
- `contracts/chunking-strategy-settings.openapi.yaml` defines the retrieval-settings schema change and clarifies that document ingests use the active account strategy without a request-shape change.
- `quickstart.md` captures the test-first implementation and verification path across backend, frontend, and ingest fallback behavior.

## Implementation Strategy

1. Extend retrieval settings validation, persistence, transport schema, frontend API types, and settings UI to support account-scoped `chunkingStrategy`.
2. Extract a chunking strategy seam in the retrieval domain so ingestion can resolve the active strategy through one shared interface.
3. Move the existing fixed-window logic into its own strategy module and preserve it as the default implementation.
4. Add the structure-aware chunking path with deterministic block parsing, bounded adjacent semantic merging, and deterministic structure-only fallback.
5. Wire `DocumentIngestionService` and dependency construction to load settings, resolve the chosen strategy, and apply it on document create and update flows.
6. Add backend-first TDD coverage, then contract/integration coverage, then targeted frontend verification for the selector and explanatory behavior.

## Testing Strategy

- Backend unit tests for retrieval settings validation defaults and supported `chunkingStrategy` values
- Backend unit tests for fixed-window strategy extraction, structured block parsing, bounded block splitting, adjacent merge decisions, and structure-only fallback
- Backend unit tests for `DocumentIngestionService` strategy resolution and strategy application
- Backend contract tests for retrieval settings payload shape including `chunkingStrategy`
- Backend integration tests for settings persistence, ingest behavior under both strategies, and no silent re-chunking of existing documents until update or re-ingest
- Targeted frontend verification for selector rendering, persistence, and explanatory copy

## Post-Design Constitution Check

- Spec-first gate remains satisfied. Pass.
- Backend TDD scope is explicit in the testing strategy. Pass.
- Stack discipline remains unchanged. Pass.
- No new secret or provider changes are introduced. Pass.
- Customer data remains account-scoped and auditable through existing settings and document flows. Pass.
- Transport, orchestration, domain, persistence, and frontend ownership boundaries remain explicit. Pass.
- No constitution violations require justification.

## Complexity Tracking

No constitution exceptions or justified violations are required for this plan.
