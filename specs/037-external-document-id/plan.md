# Implementation Plan: External Document ID

**Branch**: `037-external-document-id` | **Date**: 2026-04-14 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/spec.md)
**Input**: Feature specification from `/specs/037-external-document-id/spec.md`

## Summary

Add an optional immutable `externalDocumentId` to the existing inline document write contract, enforce workspace-scoped uniqueness in PostgreSQL so repeated creates become tenant-safe idempotent upserts, keep the internal UUID as the canonical document key for all existing read and delete flows, and update the code-first document API contract and tests to reflect the additive field.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router  
**Storage**: PostgreSQL 16 with `pgvector`; additive `documents.external_document_id` persistence with workspace-scoped uniqueness  
**Testing**: Vitest unit, integration, and contract tests in `backend/tests`; OpenAPI contract verification through existing contract coverage  
**Target Platform**: Web application with authenticated workspace document APIs  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current document write latency while keeping idempotent conflict handling in a single database round trip and avoiding duplicate queued documents for the same workspace/external identity  
**Constraints**: No new external-ID read/query endpoints, internal document UUID remains canonical, backend TDD is mandatory, source-kind restrictions must remain intact, HTTP contracts stay code-first, and cross-tenant writes must never collide  
**Scale/Scope**: Backend-focused additive feature touching document schema validation, repository persistence, ingestion orchestration, API contracts, generated OpenAPI artifacts, and document tests; no new user-facing UI

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/037-external-document-id/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks start with failing contract, integration, and unit coverage for idempotent writes and immutability.
- Stack remains Node.js for backend and React for frontend. Pass: backend-only implementation in the existing TypeScript/Node stack; no stack changes.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: additive Postgres column and unique index only.
- LLM provider is GPT-5.2 for AI integrations. Pass: feature does not alter AI provider behavior.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets are introduced.
- Customer data handling and auditability are addressed where applicable. Pass: workspace scope remains the tenant boundary and document write audit signals remain available.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned seams below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `documentRoutes.ts`, `DocumentIngestionService`, and `DocumentRepository` each retain clear ownership.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: repository-level upsert helpers will be introduced before route/service branching broadens.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: document request/response schemas will be updated there and generated outputs refreshed.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: document API contract docs and feature artifacts will be updated in the same change.

## Project Structure

### Documentation (this feature)

```text
specs/037-external-document-id/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── document-external-id-contract.md
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
│   │           └── documentRoutes.ts
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 014_external_document_id.sql
│   │   └── repositories/
│   │       └── documentRepository.ts
│   └── modules/
│       └── documents/
│           └── services/
│               └── documentIngestionService.ts
├── openapi.yaml
├── openapi.json
└── tests/
    ├── contract/
    │   ├── document.contract.test.ts
    │   └── openapi.contract.test.ts
    ├── integration/
    │   ├── document-settings.integration.test.ts
    │   └── persistence.integration.test.ts
    └── unit/
        └── document-ingestion.test.ts
```

**Structure Decision**: Keep document request validation in `backend/src/app/http/routes/documentRoutes.ts`, document write orchestration in `backend/src/modules/documents/services/documentIngestionService.ts`, and tenant-scoped uniqueness/upsert behavior in `backend/src/db/repositories/documentRepository.ts`. Persist the new identity field with an additive migration and surface it through the code-first OpenAPI registry at `backend/src/app/http/openapi/document.ts`. No frontend ownership changes are required.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/documentRoutes.ts` validates payloads and maps request fields to service calls only; `backend/src/app/http/openapi/document.ts` owns the runtime contract shape.
- **Orchestration Layer**: `backend/src/modules/documents/services/documentIngestionService.ts` decides whether a write is a create, idempotent external upsert, or explicit update-by-internal-ID while preserving source-kind restrictions and audit behavior.
- **Domain Layer**: document write identity rules live in focused service/repository helpers that decide when `externalDocumentId` can be assigned, reused, or rejected as immutable/conflicting.
- **Persistence/Integration Layer**: `backend/src/db/repositories/documentRepository.ts` and the new migration own the `external_document_id` column, workspace-scoped uniqueness index, and conflict-safe create/update operations.
- **Files Kept Small**: `documentRoutes.ts` must not absorb idempotency logic; `documentIngestionService.ts` must remain orchestration-focused rather than embedding SQL branching; `documentRepository.ts` must keep external-ID-specific logic in focused helpers rather than scattering it across unrelated methods.
- **Planned Extractions**:
  - additive document record/input fields for `externalDocumentId`
  - focused repository create-or-upsert-by-external-identity helper
  - focused service guard for immutable external identity assignment
- **Required Refactor Stories**:
  - extend document repository types and row mapping before route/service schema changes rely on the new field
  - add explicit upsert/assignment helpers before broadening `DocumentIngestionService` branching

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/research.md) for the workspace-scoped uniqueness, immutable identity, and existing-route upsert decisions.

## Phase 1: Design & Contracts

- The document identity additions and state rules are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/data-model.md).
- The additive document contract behavior is defined in [document-external-id-contract.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/contracts/document-external-id-contract.md).
- Validation scenarios for idempotent creates, immutable identity conflicts, and backward-compatible writes are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains enforceable because contract, unit, integration, and persistence behaviors all have isolated seams for failing tests before implementation.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 constraints remain unchanged.
- HTTP contract changes are explicitly routed through `backend/src/app/http/openapi/document.ts`, with generated OpenAPI files treated as outputs only.
- Ownership seams are improved rather than blurred: request validation remains in routes, orchestration remains in `DocumentIngestionService`, and tenant-local uniqueness remains in the repository/database.
- No constitution violations or exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
