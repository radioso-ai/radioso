# Implementation Plan: Retrieval Pipeline Stages

**Branch**: `021-retrieval-stages` | **Date**: 2026-03-21 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/radioso-retrieval-stages-spec/specs/021-retrieval-stages/spec.md)
**Input**: Feature specification from `/specs/021-retrieval-stages/spec.md`

## Summary

Refactor the backend retrieval pipeline so `RetrievalPipelineService` remains the stable entrypoint but delegates major retrieval phases to focused stage modules with explicit input and output contracts. Preserve retrieval behavior, prompt/citation compatibility, and diagnostics while improving test seams and making module ownership explicit.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest  
**Storage**: PostgreSQL 16 with `pgvector` (unchanged)  
**Testing**: Vitest unit and integration tests under `backend/tests`  
**Target Platform**: Node.js backend service running on server infrastructure  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current retrieval latency envelope and avoid adding extra retrieval passes or network hops during a chat request  
**Constraints**: No user-visible behavior change, no schema change, no workflow framework adoption, maintain current retrieval result contract for existing callers  
**Scale/Scope**: Backend-only refactor centered on `backend/src/modules/retrieval/services/retrievalPipelineService.ts` and related retrieval service tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved `spec.md` exists in `specs/021-retrieval-stages/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks will require red/green test tasks before refactor changes.
- Stack remains Node.js for backend and React for frontend. Pass: backend-only TypeScript/Node refactor.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no storage change.
- LLM provider is GPT-5.2 for AI integrations. Pass: no LLM integration change.
- Secrets and keys are managed via `.env` and `.env.example` are updated. Pass: no config changes expected.
- Customer data handling and auditability are addressed where applicable. Pass: no new data flows; diagnostics behavior must be preserved.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with required extractions listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `RetrievalPipelineService` is explicitly being reduced to orchestration.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: foundational refactor tasks precede any cleanup of caller wiring.

## Project Structure

### Documentation (this feature)

```text
specs/021-retrieval-stages/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── internal-stage-contracts.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── chat/
│   │   │   └── services/
│   │   │       └── chatService.ts
│   │   └── retrieval/
│   │       ├── domain/
│   │       │   └── retrievalPipelineTypes.ts
│   │       ├── infra/
│   │       │   ├── lexicalSearch.ts
│   │       │   └── vectorSearch.ts
│   │       └── services/
│   │           ├── retrievalPipelineService.ts
│   │           ├── queryRewriteService.ts
│   │           ├── candidatePreparationService.ts
│   │           ├── attributeMatchScoringService.ts
│   │           ├── promptContextSelectorService.ts
│   │           ├── promptBuilder.ts
│   │           ├── retrievalExecutionTelemetryService.ts
│   │           └── conversationContextService.ts
│   └── app/
└── tests/
    ├── integration/
    ├── contract/
    └── unit/
```

**Structure Decision**: Keep the feature entirely within `backend/src/modules/retrieval/` and `backend/tests/`. `RetrievalPipelineService` remains the orchestration entrypoint. Retrieval stage modules will live in `backend/src/modules/retrieval/services/` or a focused retrieval subfolder under services if needed. Existing `infra/` files keep persistence/search ownership. `chatService.ts` and HTTP wiring remain callers only and must not absorb retrieval-stage logic.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*.ts` and chat route wiring translate requests and responses only.
- **Orchestration Layer**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts` coordinates stage execution and assembles the final pipeline result.
- **Domain Layer**: Focused retrieval stage services own query interpretation, candidate retrieval composition, candidate scoring/preparation, context selection, prompt assembly, and diagnostics creation.
- **Persistence/Integration Layer**: `backend/src/modules/retrieval/infra/vectorSearch.ts`, `backend/src/modules/retrieval/infra/lexicalSearch.ts`, and existing service ports own DB-facing integrations.
- **Files Kept Small**: `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, and `backend/src/modules/retrieval/infra/*.ts` must not absorb unrelated responsibilities.
- **Planned Extractions**:
  - retrieval settings/context stage
  - query interpretation stage
  - candidate retrieval stage
  - candidate preparation stage
  - context selection stage
  - prompt assembly stage
  - diagnostics assembly stage
- **Required Refactor Stories**:
  - Introduce stable stage input/output contracts before moving orchestration logic.
  - Update unit tests around the pipeline and new stage seams before broadening the refactor.

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/radioso-retrieval-stages-spec/specs/021-retrieval-stages/research.md) for the concrete decisions that resolve the main architecture unknowns.

## Phase 1: Design & Contracts

- Stage boundaries and data passed between them are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/radioso-retrieval-stages-spec/specs/021-retrieval-stages/data-model.md).
- Internal module contracts for the orchestrator and stage interfaces are defined in [internal-stage-contracts.md](/Users/dm/conductor/workspaces/radioso/radioso-retrieval-stages-spec/specs/021-retrieval-stages/contracts/internal-stage-contracts.md).
- Regression-oriented execution guidance is defined in [quickstart.md](/Users/dm/conductor/workspaces/radioso/radioso-retrieval-stages-spec/specs/021-retrieval-stages/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains required and will be enforced in tasks before refactor code moves.
- No stack or persistence changes are introduced by the design.
- Ownership seams are explicit and mapped to concrete backend files.
- The plan adds architecture-first tasks before any caller-impacting cleanup.
- No constitution violations require exception handling.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
