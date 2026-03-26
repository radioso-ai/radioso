# Implementation Plan: Split Document Worker Runtime

**Branch**: `029-split-document-worker` | **Date**: 2026-03-26 | **Spec**: [/Users/dm/conductor/workspaces/radioso/beijing-v1/specs/029-split-document-worker/spec.md](/Users/dm/conductor/workspaces/radioso/beijing-v1/specs/029-split-document-worker/spec.md)
**Input**: Feature specification from `/specs/029-split-document-worker/spec.md`

## Summary

Split the backend into explicit API and document-worker runtimes while preserving the current database-backed processing model. The API runtime will own SQL migrations and connector bootstrapping; the worker runtime will fail fast on pending schema changes, execute the existing polling worker independently, and emit role-specific operational logs. Local orchestration will gain explicit backend and backend-worker services plus named backend scripts for API-only and worker-only debugging.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, `pg`, Zod, Pino, Vitest, Supertest, local connector packages  
**Storage**: PostgreSQL 16 with `pgvector`, existing `document_processing_jobs`, existing connector config persistence  
**Testing**: Vitest unit, integration, and contract tests  
**Target Platform**: Linux container runtime and host-based Node.js development workflows  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current API responsiveness while isolating background document processing from HTTP serving  
**Constraints**: No broker queue introduction, no backend HTTP contract changes, API runtime owns connector migration/init, worker must fail fast on pending SQL migrations  
**Scale/Scope**: One backend runtime split across two long-running processes plus local orchestration updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated only if configuration changes.
- Customer data handling is unchanged functionally; runtime failure modes will fail fast and log explicitly rather than process on stale schema.
- Module boundaries are explicit: routes stay in HTTP transport, boot logic moves to focused runtime/bootstrap modules, worker logic stays in `DocumentProcessingWorker`, persistence stays in repositories.
- `backend/src/app/server/createApp.ts` remains responsibility-limited to HTTP composition only.
- No backend HTTP contract changes are planned, so no OpenAPI registry changes should be needed.

**Post-design check**: Pass. The runtime split is implemented through new startup seams rather than expanding `createApp.ts` or moving worker logic into routes.

## Project Structure

### Documentation (this feature)

```text
specs/029-split-document-worker/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── config/
│   │   ├── http/
│   │   └── server/
│   ├── db/
│   ├── modules/
│   │   ├── connectors/
│   │   └── documents/
│   ├── runtime/              # new shared/runtime-specific startup seams
│   ├── httpServer.ts         # new API runtime entrypoint
│   ├── documentWorker.ts     # new worker runtime entrypoint
│   └── index.ts              # compatibility entrypoint delegating to API runtime
├── tests/
└── package.json

infra/
├── backend.dev.entrypoint.sh
├── docker-compose.dev.yml
└── docker-compose.yml
```

**Structure Decision**: Keep the existing backend package and add a focused `backend/src/runtime/` seam for environment loading, migration ownership checks, connector bootstrapping ownership, and role-specific shutdown. `backend/src/httpServer.ts` will own API startup orchestration, `backend/src/documentWorker.ts` will own worker startup orchestration, `backend/src/modules/documents/services/documentProcessingWorker.ts` will remain the polling/processing domain owner, and repository/database access remains under `backend/src/db/`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*`, middleware, presenters, and `backend/src/app/server/createApp.ts`
- **Orchestration Layer**: new `backend/src/runtime/*` modules plus role-specific entrypoints that sequence startup and shutdown
- **Domain Layer**: `backend/src/modules/documents/services/documentProcessingWorker.ts` and existing document/chat services
- **Persistence/Integration Layer**: `backend/src/db/*`, connector registry/database integration, document storage
- **Files Kept Small**: `backend/src/app/server/createApp.ts`, `backend/src/index.ts`, `backend/src/modules/documents/services/documentProcessingWorker.ts`
- **Planned Extractions**:
  - runtime environment loader
  - runtime migration-state helper
  - shared dependency bootstrap helper
  - role-specific startup/shutdown helpers
- **Required Refactor Stories**: Split current `backend/src/index.ts` boot sequence before adding any new worker/API lifecycle behavior

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |
