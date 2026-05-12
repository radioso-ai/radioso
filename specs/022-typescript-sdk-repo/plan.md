# Implementation Plan: Radioso TypeScript SDK

**Branch**: `borohhov/typescript-sdk` | **Date**: 2026-04-04 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/spec.md)
**Input**: Feature specification from `/specs/022-typescript-sdk-repo/spec.md`

## Summary

Create an in-repo `typescript-sdk/` package for token-based external integrations, drive its generated request and response surface from the backend’s code-first OpenAPI contract, add a handwritten streaming chat adapter where raw generation is insufficient, and keep repository separation deferred until the package surface and contract-refresh workflow have proven stable.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 for the SDK package and backend contract tooling
**Primary Dependencies**: Existing backend code-first OpenAPI registry, npm package scripts, TypeScript build tooling, Vitest, and an OpenAPI-to-TypeScript client generation toolchain for contract-derived models and operations  
**Storage**: Filesystem only for generated contract snapshots and package artifacts under `typescript-sdk/`; PostgreSQL unchanged  
**Testing**: Vitest contract and integration validation in `backend/tests` and `typescript-sdk/tests`; quickstart verification against a running Radioso backend  
**Target Platform**: Node.js-consumable TypeScript SDK for external developers integrating with Radioso over HTTP  
**Project Type**: Web application repository with a new in-repo SDK package plus existing `backend/` and `frontend/` projects  
**Performance Goals**: SDK request overhead remains negligible beyond normal fetch cost; streaming chat surfaces incremental events without buffering the full stream before delivery  
**Constraints**: Keep the backend OpenAPI registry as the sole contract source, normalize token-auth documentation before generation, preserve modular seams between generated transport and handwritten ergonomics, exclude browser-session/admin-only flows from v1, and update docs in the same change  
**Scale/Scope**: Cross-cutting feature touching backend contract metadata, a new `typescript-sdk/` package, package tests, generated contract snapshots, and SDK consumer docs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/022-typescript-sdk-repo/`.
- Backend work includes TDD with failing tests written before implementation. Pass: foundational backend contract normalization starts with failing contract tests before code changes.
- Stack remains Node.js for backend and React for frontend. Pass: the new SDK package is Node.js/TypeScript only; no stack deviation.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no database shape change is required.
- LLM provider is GPT-5.2 for AI integrations. Pass: SDK work consumes existing HTTP APIs only and does not change provider integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secret types are expected; quickstart docs will reference existing token issuance flows.
- Customer data handling and auditability are addressed where applicable. Pass: v1 is token-scoped, excludes admin-only flows, and keeps transport semantics aligned with existing backend auth boundaries.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `backend/src/app/http/openapi/document.ts` remains contract-only, and the SDK package separates generated surface, handwritten transport helpers, streaming, and docs.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: auth-contract normalization lands before SDK generation, and the SDK package introduces focused seams rather than a single monolithic client file.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: token-auth security metadata will be corrected there first.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: `typescript-sdk/README.md` plus contract-refresh instructions are in scope.

## Project Structure

### Documentation (this feature)

```text
specs/022-typescript-sdk-repo/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── sdk-surface-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   └── app/
│       └── http/
│           └── openapi/
│               └── document.ts
├── scripts/
│   └── generateOpenApi.ts
├── openapi.json
├── openapi.yaml
└── tests/
    └── contract/
        ├── openapi.contract.test.ts
        └── sdk-openapi.contract.test.ts

typescript-sdk/
├── package.json
├── tsconfig.json
├── README.md
├── openapi/
│   ├── radioso.json
│   └── radioso.yaml
├── scripts/
│   └── sync-openapi.mjs
├── src/
│   ├── generated/
│   │   ├── client.ts
│   │   └── types.ts
│   ├── core/
│   │   ├── config.ts
│   │   ├── errors.ts
│   │   └── http.ts
│   ├── streaming/
│   │   └── chatStream.ts
│   └── index.ts
└── tests/
    ├── integration/
    │   ├── sdk-client.integration.test.ts
    │   └── sdk-chat-stream.integration.test.ts
    └── unit/
        ├── sdk-config.test.ts
        ├── sdk-errors.test.ts
        └── chat-stream.test.ts
```

**Structure Decision**: Keep backend contract ownership inside `backend/src/app/http/openapi/document.ts` and the generated artifact script in `backend/scripts/generateOpenApi.ts`. Introduce `typescript-sdk/` as a standalone in-repo package whose `src/generated/` directory owns contract-derived operations and types, whose `src/core/` directory owns runtime configuration and normalized error handling, and whose `src/streaming/` directory owns the handwritten chat stream adapter. Package docs and quickstart guidance live in `typescript-sdk/README.md` rather than being mixed into backend docs.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/openapi/document.ts` owns HTTP contract metadata only; `typescript-sdk/src/generated/client.ts` owns generated operation calls; `typescript-sdk/src/core/http.ts` owns runtime request execution wrappers only.
- **Orchestration Layer**: `typescript-sdk/src/index.ts` composes generated operations, config, and streaming helpers into the public SDK surface without redefining endpoint semantics.
- **Domain Layer**: `typescript-sdk/src/core/config.ts` owns client configuration rules, `typescript-sdk/src/core/errors.ts` owns SDK error normalization, and `typescript-sdk/src/streaming/chatStream.ts` owns typed stream event parsing and delivery.
- **Persistence/Integration Layer**: `backend/scripts/generateOpenApi.ts` emits canonical OpenAPI artifacts; `typescript-sdk/scripts/sync-openapi.mjs` imports those artifacts into the SDK package and refreshes generated sources.
- **Files Kept Small**: `backend/src/app/http/openapi/document.ts` must not absorb SDK runtime logic; `typescript-sdk/src/index.ts` must not absorb low-level stream parsing or error-shape logic; generated files under `typescript-sdk/src/generated/` must not become the home for handwritten business rules.
- **Planned Extractions**:
  - dedicated SDK package config module
  - dedicated SDK error normalization module
  - dedicated streaming chat adapter layered on top of generated transport
  - dedicated contract-sync script to refresh package artifacts from backend outputs
- **Required Refactor Stories**:
  - correct token-auth security metadata in the backend OpenAPI registry before SDK generation
  - establish the package sync flow before exposing a handwritten public SDK surface

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/research.md) for the in-repo package decision, the generated-plus-handwritten SDK shape, the token-auth contract normalization requirement, and the v1 support-boundary decisions.

## Phase 1: Design & Contracts

- The SDK release surface, contract snapshot, client configuration, supported operation, and streaming event model are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/data-model.md).
- The initial token-based SDK scope and backend-contract expectations are defined in [sdk-surface-contract.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/contracts/sdk-surface-contract.md).
- Validation flows for token configuration, standard requests, streaming chat, and contract refresh are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains enforceable because backend contract normalization begins with failing contract coverage before `document.ts` changes.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 constraints remain unchanged.
- HTTP contract ownership remains in `backend/src/app/http/openapi/document.ts`; generated `backend/openapi.yaml` and `backend/openapi.json` stay artifacts only.
- The SDK package improves ownership clarity by separating generated transport, runtime config, error normalization, and streaming handling rather than extending backend or frontend app code.
- Documentation parity is preserved by making `typescript-sdk/README.md` and contract-refresh workflow updates part of the feature scope.
- No constitution violations or exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
