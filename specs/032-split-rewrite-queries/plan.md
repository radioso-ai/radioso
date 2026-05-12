# Implementation Plan: Split Semantic And Lexical Query Rewrite

**Branch**: `032-split-rewrite-queries` | **Date**: 2026-03-31 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/spec.md)
**Input**: Feature specification from `/specs/032-split-rewrite-queries/spec.md`

## Summary

Extend retrieval settings with separate semantic and lexical rewrite instructions, evolve the retrieval rewrite output so query interpretation can select distinct active semantic and lexical queries, and surface those split-query decisions in the existing retrieval settings UI, code-first settings API, and retrieval trace experience while preserving safe fallback behavior.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives  
**Storage**: PostgreSQL 16 with `pgvector`; additive retrieval-settings persistence for semantic and lexical rewrite instruction fields  
**Testing**: Vitest unit, integration, and contract tests in `backend/tests`; frontend verification through the existing retrieval settings flow and retrieval trace UI  
**Target Platform**: Web application with authenticated admin settings UI and Node.js backend APIs  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve the current retrieval latency envelope by keeping phase 1 to one semantic query and one lexical query per request, with no extra retrieval round trips beyond the existing semantic and lexical stages  
**Constraints**: Preserve current retrieval pipeline entrypoints and caller contracts, keep fallback behavior stable, keep HTTP contracts code-first, avoid deterministic rule engines in this phase, and keep the design extensible for future multiple lexical variants  
**Scale/Scope**: Cross-cutting backend/frontend feature touching retrieval settings domain and persistence, settings HTTP schemas, query rewrite and interpretation services, retrieval diagnostics/trace output, OpenAPI generation, and the retrieval settings UI

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/032-split-rewrite-queries/`.
- Backend work includes TDD with failing tests written before implementation. Pass: implementation tasks will start with failing unit, contract, and integration tests for split settings, rewrite outputs, and diagnostics.
- Stack remains Node.js for backend and React for frontend. Pass: TypeScript/Node backend and React/Next frontend only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: additive retrieval-settings storage only; no database or search stack replacement.
- LLM provider is GPT-5.2 for AI integrations. Pass: rewrite remains on the existing GPT-5.2-backed rewrite capability.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass: workspace-scoped settings and retrieval traces remain account-bound and additive diagnostics stay within the existing bounded trace surface.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: settings routes, retrieval settings service, query interpretation stage, query rewrite service, and retrieval settings UI are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: split rewrite contracts and settings/domain helpers land before trace and UI wiring broadens.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: retrieval settings schemas must be updated there and generated artifacts refreshed.

## Project Structure

### Documentation (this feature)

```text
specs/032-split-rewrite-queries/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── retrieval-settings-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   └── http/
│   │       ├── openapi/
│   │       │   └── document.ts
│   │       └── routes/
│   │           └── settingsRoutes.ts
│   ├── db/
│   │   └── repositories/
│   │       └── retrievalSettingsRepository.ts
│   └── modules/
│       ├── retrieval/
│       │   ├── domain/
│       │   │   ├── retrievalPipelineTypes.ts
│       │   │   └── structuredAttributes.ts
│       │   └── services/
│       │       ├── queryRewriteService.ts
│       │       ├── queryInterpretationStage.ts
│       │       ├── queryConstraintParser.ts
│       │       ├── retrievalDiagnosticsStage.ts
│       │       ├── retrievalTraceAssembler.ts
│       │       ├── retrievalInfoPresenter.ts
│       │       └── candidateRetrievalStage.ts
│       └── settings/
│           ├── domain/
│           │   └── retrievalSettings.ts
│           └── services/
│               └── retrievalSettingsService.ts
└── tests/
    ├── contract/
    │   └── settings.contract.test.ts
    ├── integration/
    │   ├── document-settings.integration.test.ts
    │   └── chat.integration.test.ts
    └── unit/
        ├── retrieval-settings-and-chunking.test.ts
        ├── retrieval-pipeline-stages.test.ts
        ├── edge-cases.test.ts
        └── hybrid-retrieval-info.test.ts

frontend/
├── components/
│   └── dashboard/
│       ├── chat-retrieval-trace-detail.tsx
│       └── settings/
│           └── retrieval-settings-panel.tsx
└── lib/
    └── api.ts
```

**Structure Decision**: Keep transport and code-first schema changes in `backend/src/app/http/routes/settingsRoutes.ts` and `backend/src/app/http/openapi/document.ts`. Keep retrieval settings defaults, validation, and compatibility in `backend/src/modules/settings/domain/retrievalSettings.ts` with persistence in `backend/src/db/repositories/retrievalSettingsRepository.ts`. Keep rewrite prompting and normalization in `backend/src/modules/retrieval/services/queryRewriteService.ts`, while `backend/src/modules/retrieval/services/queryInterpretationStage.ts` stays the orchestration seam that selects active semantic and lexical queries for downstream retrieval. Keep retrieval diagnostics and trace presentation in their current dedicated modules. On the frontend, keep `retrieval-settings-panel.tsx` as the presentation container and extend only the rewrite configuration and trace display portions.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts` accepts and returns retrieval settings payloads only; `backend/src/app/http/openapi/document.ts` owns runtime request/response schemas; `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` and `frontend/components/dashboard/chat-retrieval-trace-detail.tsx` own presentation and interaction only.
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts` loads and persists workspace settings without owning rewrite prompt logic; `backend/src/modules/retrieval/services/queryInterpretationStage.ts` chooses effective semantic and lexical queries without owning HTTP or persistence concerns.
- **Domain Layer**: `backend/src/modules/settings/domain/retrievalSettings.ts` owns split rewrite instruction types, defaults, and validation; `backend/src/modules/retrieval/services/queryRewriteService.ts` owns rewrite prompting, normalization, split-query output, and fallback policy; retrieval diagnostics helpers own presentation-safe summary assembly.
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts` owns storage and backward-compatible reads/writes for retrieval settings; existing LLM provider registry and rewrite gateway remain the integration seam for model-backed rewrite generation.
- **Files Kept Small**: `settingsRoutes.ts` must not absorb rewrite policy; `retrievalSettingsService.ts` must not absorb model prompting; `queryInterpretationStage.ts` must remain orchestration-focused; `retrieval-settings-panel.tsx` must not become the source of truth for validation or rewrite semantics.
- **Planned Extractions**:
  - split rewrite settings fields and default helpers
  - split rewrite result contract carrying semantic and lexical query outputs
  - rewrite normalization helpers that validate each query mode independently
  - trace presentation helpers for split-query diagnostics labels
- **Required Refactor Stories**:
  - extend retrieval settings domain and persistence before changing rewrite execution
  - introduce split rewrite output types before updating query interpretation and diagnostics consumers
  - update code-first schemas and frontend API types in the same slice as the settings payload expansion

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/research.md) for the split-prompting, settings-storage, fallback, and diagnostics decisions.

## Phase 1: Design & Contracts

- The workspace retrieval settings and split rewrite result entities are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/data-model.md).
- The retrieval settings contract changes are defined in [retrieval-settings-contract.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/contracts/retrieval-settings-contract.md).
- Validation scenarios for settings saves, query interpretation behavior, and trace output are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/032-split-rewrite-queries/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains enforceable because split settings validation, rewrite output normalization, query interpretation, and diagnostics all have isolated seams for failing tests first.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 provider constraints remain unchanged.
- HTTP contract changes are explicitly routed through `backend/src/app/http/openapi/document.ts`, with generated OpenAPI files treated as outputs only.
- Ownership seams are improved rather than blurred: settings persistence stays in the settings module, model prompting stays in rewrite services, and trace/UI presentation remains outside core rewrite logic.
- No constitution violations or exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
