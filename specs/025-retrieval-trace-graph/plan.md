# Implementation Plan: Retrieval Trace Graph

**Branch**: `025-retrieval-trace-graph` | **Date**: 2026-03-23 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/spec.md)
**Input**: Feature specification from `/specs/025-retrieval-trace-graph/spec.md`

## Summary

Add an operator-facing retrieval trace for each retrieval-backed assistant answer by extending the existing retrieval diagnostics flow into a structured `RetrievalTrace`, exposing it on live chat responses and chat-history detail, persisting it through the existing audit metadata path, and rendering it as a bounded graph with stage drill-down plus raw trace inspection. Preserve the current compact `retrievalInfo` summary and keep retrieval behavior, chat orchestration, and historical replay responsibilities separated.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives, React Flow for the trace graph UI  
**Storage**: PostgreSQL 16 with `pgvector`; reuse existing audit-event metadata for persisted trace replay, no new storage system planned  
**Testing**: Vitest unit, contract, and integration tests under `backend/tests`; frontend component/state verification in existing frontend test approach plus manual operator-flow verification  
**Target Platform**: Web application with Node.js backend service and Next.js admin frontend  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Keep trace assembly additive to the existing retrieval request, preserve the current chat latency envelope, and render operator diagnostics fast enough for same-session inspection  
**Constraints**: No retrieval behavior regression, bounded trace payload only, no exposure of full prompts or raw document bodies, no hand-edited generated OpenAPI files, preserve compact `retrievalInfo` compatibility, no workflow-engine adoption  
**Scale/Scope**: Additive retrieval/chat contract and UI feature spanning retrieval services, chat orchestration/history replay, audit metadata shaping, OpenAPI registry, frontend API types, chat view diagnostics, and chat-history diagnostics

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved `spec.md` exists in `specs/025-retrieval-trace-graph/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks will sequence backend contract/unit/integration tests before production changes.
- Stack remains Node.js for backend and React for frontend. Pass: additive TypeScript/Node backend and React/Next frontend work only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no database technology change; existing audit metadata remains sufficient.
- LLM provider is GPT-5.2 for AI integrations. Pass: feature does not change model integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass with explicit design requirement: trace data must remain bounded and exclude sensitive raw content while remaining replayable through audit metadata.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned trace assembly and presentation seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `retrievalPipelineService.ts`, `chatService.ts`, `chatHistoryService.ts`, and frontend view components remain bounded.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: trace assembly and presenter extraction are planned before broad UI wiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: additive contract updates will be modeled in the code-first registry.

## Project Structure

### Documentation (this feature)

```text
specs/025-retrieval-trace-graph/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── retrieval-trace-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── openapi/document.ts
│   │   └── presenters/chatPresenter.ts
│   └── modules/
│       ├── chat/services/
│       │   ├── chatService.ts
│       │   └── chatHistoryService.ts
│       └── retrieval/
│           ├── domain/retrievalPipelineTypes.ts
│           └── services/
│               ├── retrievalPipelineService.ts
│               ├── retrievalDiagnosticsStage.ts
│               ├── retrievalExecutionTelemetryService.ts
│               ├── retrievalInfoPresenter.ts
│               └── [new trace assembly / presenter modules]
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── components/dashboard/
│   ├── chat-view.tsx
│   ├── chat-history-view.tsx
│   ├── chat-retrieval-info.tsx
│   └── [new retrieval trace graph/detail components]
└── lib/
    ├── api.ts
    ├── chat-context.tsx
    └── anonymous-chat-context.tsx
```

**Structure Decision**: Keep retrieval fact generation in `backend/src/modules/retrieval/`, transport contract wiring in the backend OpenAPI registry and presenters, orchestration and audit recording in `backend/src/modules/chat/services/`, and graph rendering/state in focused frontend dashboard components. Reuse the existing audit-event metadata path for historical replay instead of introducing a new persistence layer. Preserve current chat routes, retrieval pipeline entrypoint, and compact summary presenter as stable callers/contracts with additive trace support.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*.ts`, `backend/src/app/http/presenters/chatPresenter.ts`, streaming adapters, and the code-first OpenAPI registry in `backend/src/app/http/openapi/document.ts`.
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts` and `backend/src/modules/chat/services/chatHistoryService.ts` coordinate request/response and history replay without owning trace-shaping rules.
- **Domain Layer**: Retrieval stage services remain the source of execution facts; new retrieval-trace assembly/presentation modules own conversion from stage results and diagnostics into `RetrievalTrace`.
- **Persistence/Integration Layer**: Existing audit repository/services persist and replay trace payloads through metadata, and existing retrieval infra modules keep ownership of search integrations.
- **Files Kept Small**: `backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/chat/services/chatHistoryService.ts`, `frontend/components/dashboard/chat-view.tsx`, and `frontend/components/dashboard/chat-history-view.tsx` must not absorb large trace-formatting or graph-rendering logic.
- **Planned Extractions**:
  - retrieval trace domain types in `backend/src/modules/retrieval/domain/`
  - retrieval trace assembler from pipeline stage results
  - retrieval trace presenter for API/chat consumers
  - frontend retrieval trace graph component
  - frontend retrieval trace detail/raw panel component
- **Required Refactor Stories**:
  - Extract trace assembly before expanding `RetrievalExecutionDiagnostics` consumers.
  - Add reusable frontend trace components before wiring both live chat and history views to avoid duplicated rendering logic.

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/research.md) for the concrete decisions on trace persistence, graph structure, UI visualizer choice, bounded payload rules, and workflow-scope boundaries.

## Phase 1: Design & Contracts

- The trace entities, additive chat/history payload shapes, and stage relationship model are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/data-model.md).
- Design-time API and replay contract notes for additive chat response and history detail updates are captured in [retrieval-trace-contract.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/contracts/retrieval-trace-contract.md).
- Implementation and verification flow is captured in [quickstart.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/quickstart.md).
- Backend HTTP contract ownership remains in `backend/src/app/http/openapi/document.ts`; generated `backend/openapi.yaml` and `backend/openapi.json` will be regenerated from code, never edited directly.

## Post-Design Constitution Check

- Backend TDD remains required and will be enforced in tasks before backend code changes.
- No stack or persistence-system changes are introduced; the design reuses existing audit metadata.
- Customer-data protections remain explicit through bounded trace payload rules and exclusion of sensitive raw content.
- Ownership seams are explicit across retrieval facts, chat orchestration, audit replay, OpenAPI schemas, and frontend graph rendering.
- Existing responsibility-limited files stay orchestration-only or presentation-only, with planned extractions handling new trace concerns.
- No constitution violations or exceptions are required for this feature.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
