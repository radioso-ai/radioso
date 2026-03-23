# Implementation Plan: Ingestion Settings Controls

**Branch**: `024-ingestion-settings` | **Date**: 2026-03-23 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/spec.md)
**Input**: Feature specification from `/specs/024-ingestion-settings/spec.md`

## Summary

Split document-preparation controls out of Retrieval into a dedicated Ingestion settings surface, persist them as a separate workspace-scoped configuration model, and add a workspace-level reprocess action that safely re-queues eligible documents without silently rewriting existing chunks at save time.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Next.js App Router, Radix UI, Vitest, Supertest  
**Storage**: PostgreSQL 16 with `pgvector`; additive workspace-scoped ingestion settings storage and existing document-processing tables  
**Testing**: Vitest unit, integration, and contract tests across `backend/tests`; frontend interaction coverage where existing patterns support it  
**Target Platform**: Web application with server-rendered admin UI and Node.js backend APIs  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current settings load/save responsiveness and preserve current document-processing throughput for normal ingest/update paths; workspace reprocess should queue eligible documents in one request without per-document HTTP round trips  
**Constraints**: No silent chunk rewrites on settings save; keep generated OpenAPI outputs code-first; preserve existing retrieval behavior after chunking controls move; avoid exposing worker/provider internals as user settings  
**Scale/Scope**: Cross-cutting backend and frontend feature touching settings API, chunking configuration, document reprocessing orchestration, OpenAPI registry, and Settings UI tabs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/024-ingestion-settings/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks will require red/green coverage for settings validation, bulk reprocess orchestration, and OpenAPI contract updates before implementation code.
- Stack remains Node.js for backend and React for frontend. Pass: TypeScript/Node backend and React/Next frontend only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: additive settings storage only, no persistence stack change.
- LLM provider is GPT-5.2 for AI integrations. Pass: no LLM provider change.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass: workspace-scoped settings and document reprocess actions continue to use bearer-authenticated workspace context and should emit audit events for settings change and bulk reprocess initiation.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned extractions listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `settingsRoutes.ts`, `settings-view.tsx`, and `documentIngestionService.ts` are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: add focused ingestion-settings domain/service/repository modules and a dedicated workspace reprocess orchestration seam before UI wiring broadens existing files.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: new ingestion settings schemas and route registrations will be added there, then generated outputs regenerated.

## Project Structure

### Documentation (this feature)

```text
specs/024-ingestion-settings/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── ingestion-settings-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── http/
│   │   │   ├── openapi/
│   │   │   │   └── document.ts
│   │   │   └── routes/
│   │   │       ├── settingsRoutes.ts
│   │   │       └── documentRoutes.ts
│   │   └── server/
│   │       └── dependencies.ts
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 009_ingestion_settings.sql
│   │   └── repositories/
│   │       ├── retrievalSettingsRepository.ts
│   │       ├── ingestionSettingsRepository.ts
│   │       └── documentRepository.ts
│   └── modules/
│       ├── documents/
│       │   └── services/
│       │       ├── documentIngestionService.ts
│       │       ├── documentProcessingService.ts
│       │       └── workspaceIngestionReprocessService.ts
│       └── settings/
│           ├── domain/
│           │   ├── retrievalSettings.ts
│           │   └── ingestionSettings.ts
│           └── services/
│               ├── retrievalSettingsService.ts
│               └── ingestionSettingsService.ts
└── tests/
    ├── contract/
    │   └── settings.contract.test.ts
    ├── integration/
    │   └── document-settings.integration.test.ts
    └── unit/
        ├── ingestion-settings.test.ts
        └── workspace-ingestion-reprocess.test.ts

frontend/
├── components/
│   └── dashboard/
│       └── settings-view.tsx
└── lib/
    └── api.ts
```

**Structure Decision**: Keep transport changes in `backend/src/app/http/routes/settingsRoutes.ts` and the code-first registry in `backend/src/app/http/openapi/document.ts`. Create a dedicated ingestion-settings domain and service in `backend/src/modules/settings/` so retrieval and ingestion stop sharing one settings model. Keep chunking execution in `documentProcessingService.ts`, which will read ingestion settings instead of retrieval settings. Add a focused `workspaceIngestionReprocessService.ts` to own bulk re-queue rules. On the frontend, keep the Settings page in `frontend/components/dashboard/settings-view.tsx` but split the current retrieval-only panel into dedicated `General`, `Ingestion`, and `Retrieval` panel sections.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts` accepts and validates retrieval/general/ingestion requests only; `backend/src/app/http/openapi/document.ts` owns runtime-aligned schema registration; frontend `settings-view.tsx` owns tab composition and form presentation only.
- **Orchestration Layer**: `ingestionSettingsService.ts` loads and saves workspace ingestion settings; `workspaceIngestionReprocessService.ts` coordinates workspace-level bulk re-queue behavior; `documentProcessingService.ts` consumes the active ingestion settings during processing.
- **Domain Layer**: `ingestionSettings.ts` owns defaults, validation, supported chunking strategies, and legal size relationships; chunking strategy modules continue owning chunk construction rules.
- **Persistence/Integration Layer**: `ingestionSettingsRepository.ts` owns ingestion-settings storage; `documentRepository.ts` owns bulk eligibility lookup and re-queue persistence; `retrievalSettingsRepository.ts` is reduced to retrieval-only concerns.
- **Files Kept Small**: `settingsRoutes.ts` must not absorb chunking logic or per-document queue rules. `settings-view.tsx` must not become a large all-settings state machine; if needed, panel-local helpers should be extracted. `documentIngestionService.ts` must not absorb workspace-bulk orchestration concerns.
- **Planned Extractions**:
  - dedicated ingestion settings domain types/defaults/validation
  - dedicated ingestion settings service and repository
  - dedicated workspace bulk reprocess service
  - dedicated frontend ingestion settings panel state and API calls
- **Required Refactor Stories**:
  - separate chunking settings from retrieval settings in backend schemas before moving UI controls
  - introduce bulk reprocess orchestration before wiring the Ingestion tab action
  - update code-first OpenAPI registry and contract tests as part of the same slice as route changes

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/research.md) for the design decisions on API shape, persistence separation, and workspace bulk reprocess safeguards.

## Phase 1: Design & Contracts

- The workspace-scoped ingestion configuration model and bulk reprocess entities are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/data-model.md).
- The planned ingestion settings and workspace reprocess API surface is defined in [ingestion-settings-contract.md](/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/contracts/ingestion-settings-contract.md).
- Verification flows for backend and UI behavior are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/edinburgh/specs/024-ingestion-settings/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains enforceable because settings validation, migration behavior, and workspace bulk reprocess logic all have isolated seams for failing tests first.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 default-provider constraints remain unchanged.
- HTTP contract changes are explicitly routed through `backend/src/app/http/openapi/document.ts`, with generated OpenAPI files treated as outputs only.
- Ownership seams are clearer after design: retrieval settings stay retrieval-only, ingestion settings become their own module, and workspace bulk reprocess avoids expanding `documentIngestionService.ts` into a god service.
- No constitution violations or exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
