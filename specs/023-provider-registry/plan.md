# Implementation Plan: Provider-Agnostic LLM Registry

**Branch**: `borohhov/provider-factory` | **Date**: 2026-03-21 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/vendor-agnostic-llm/specs/023-provider-registry/spec.md)
**Input**: Feature specification from `/specs/023-provider-registry/spec.md`

## Summary

Replace direct OpenAI-only dependency wiring with a provider-neutral capability registry that can supply chat generation, chat streaming, embeddings, query rewrite, and rerank behavior from OpenAI, Gemini, Claude, or OpenAI-compatible backends. Preserve current HTTP behavior and GPT-5.2 as the default provider while validating incompatible capability mappings early.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, native `fetch` for non-OpenAI REST integrations  
**Storage**: PostgreSQL 16 with `pgvector` (unchanged)  
**Testing**: Vitest unit, contract, and integration tests under `backend/tests`  
**Target Platform**: Node.js backend service on server infrastructure  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current chat and retrieval latency envelope without adding extra application-layer hops; keep streaming incremental for providers that support streaming  
**Constraints**: No external HTTP API change, backend TDD required, GPT-5.2 remains the default provider, configuration errors must fail early, orchestration files must not gain vendor branching  
**Scale/Scope**: Backend-only feature centered on environment parsing, dependency construction, provider integrations, and backend tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved `spec.md` is present in `specs/023-provider-registry/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks place backend tests before implementation changes.
- Stack remains Node.js for backend and React for frontend. Pass: backend-only TypeScript/Node change.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no schema or storage change.
- LLM provider is GPT-5.2 for AI integrations. Pass: GPT-5.2 remains the default provider/model path in config defaults.
- Secrets and keys are managed via `.env` and `.env.example` are updated. Pass: feature adds provider-neutral env vars and updates examples without committing secrets.
- Customer data handling and auditability are addressed where applicable. Pass: provider/model metadata will be logged or surfaced without exposing secret values.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with required new seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `dependencies.ts`, `chatService.ts`, and retrieval orchestration remain responsibility-limited.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: registry and provider contract extraction land before caller rewiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: no HTTP contract changes are planned.

## Project Structure

### Documentation (this feature)

```text
specs/023-provider-registry/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── provider-capabilities.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── config/
│   │   │   └── env.ts
│   │   └── server/
│   │       └── dependencies.ts
│   ├── modules/
│   │   ├── chat/
│   │   │   └── services/
│   │   │       └── chatService.ts
│   │   └── retrieval/
│   │       └── services/
│   │           ├── embeddingService.ts
│   │           ├── queryRewriteService.ts
│   │           └── rerankService.ts
│   └── shared/
│       └── infra/
│           ├── llm/
│           │   ├── providerRegistry.ts
│           │   ├── providerConfig.ts
│           │   ├── providerTypes.ts
│           │   ├── openaiProvider.ts
│           │   ├── geminiProvider.ts
│           │   └── claudeProvider.ts
│           └── openaiClient.ts
├── tests/
│   ├── support/
│   │   └── testApp.ts
│   └── unit/
│       ├── chat-retrieval.domain.test.ts
│       └── llm-provider-registry.test.ts
└── .env.example
```

**Structure Decision**: Keep transport and orchestration ownership unchanged. Add provider-neutral capability and configuration modules under `backend/src/shared/infra/llm/`, preserve chat/retrieval services as callers of gateway interfaces, and keep `backend/src/app/server/dependencies.ts` as composition-only wiring.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*.ts` and presenters remain request/response translators only.
- **Orchestration Layer**: `backend/src/app/server/dependencies.ts`, `backend/src/modules/chat/services/chatService.ts`, and `backend/src/modules/retrieval/services/retrievalPipelineService.ts` coordinate workflows and dependency wiring only.
- **Domain Layer**: Existing gateway interfaces in chat, embedding, rewrite, and rerank services remain the capability contracts consumed by orchestration.
- **Persistence/Integration Layer**: `backend/src/shared/infra/llm/*.ts`, `backend/src/shared/infra/openaiClient.ts`, and retrieval infra modules own provider SDK or HTTP translation and configuration validation.
- **Files Kept Small**: `backend/src/app/server/dependencies.ts`, `backend/src/modules/chat/services/chatService.ts`, and `backend/src/modules/retrieval/services/retrievalPipelineService.ts` must not gain provider-conditional behavior.
- **Planned Extractions**:
  - provider-neutral capability/config types
  - provider registry/factory
  - OpenAI/OpenAI-compatible provider adapter
  - Gemini provider adapter
  - Claude provider adapter for text-generation capabilities
  - early configuration validation and provider metadata shaping
- **Required Refactor Stories**:
  - Create capability contracts and validation before swapping dependency wiring.
  - Add provider-focused unit tests before replacing OpenAI-only construction.

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/vendor-agnostic-llm/specs/023-provider-registry/research.md) for the decisions on capability modeling, provider support boundaries, and configuration strategy.

## Phase 1: Design & Contracts

- Provider capability objects and configuration relationships are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/vendor-agnostic-llm/specs/023-provider-registry/data-model.md).
- Internal provider and capability contracts are defined in [provider-capabilities.md](/Users/dm/conductor/workspaces/radioso/vendor-agnostic-llm/specs/023-provider-registry/contracts/provider-capabilities.md).
- Validation and manual smoke scenarios are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/vendor-agnostic-llm/specs/023-provider-registry/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains required and is explicitly sequenced before implementation tasks.
- GPT-5.2 remains the default provider path in the design.
- No transport or persistence schema changes are introduced.
- Responsibility-limited files remain orchestration-only, with provider logic isolated in shared infrastructure adapters.
- The design keeps HTTP contracts stable, so no OpenAPI changes are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
