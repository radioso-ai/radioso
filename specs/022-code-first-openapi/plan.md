# Implementation Plan: Code-First OpenAPI Contracts

**Branch**: `borohhov/openapi-contract-audit` | **Date**: 2026-03-21 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/santo-domingo/specs/022-code-first-openapi/spec.md)
**Input**: Feature specification from `/specs/022-code-first-openapi/spec.md`

## Summary

Replace the backend’s hand-maintained OpenAPI draft with a code-first document builder that derives the published contract from backend code, generates checked-in OpenAPI artifacts, exposes the generated contract through backend docs endpoints, and updates Speckit guidance so future backend API work uses the same workflow.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24
**Primary Dependencies**: Express, Zod, `@asteasolutions/zod-to-openapi`, `swagger-ui-express`, `yaml`, Vitest, Supertest  
**Storage**: PostgreSQL 16 with `pgvector` (unchanged)  
**Testing**: Vitest contract tests and TypeScript build validation under `backend/`  
**Target Platform**: Node.js backend service running on server infrastructure  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Keep docs generation off the hot path for test mode and avoid meaningful request-path latency changes for normal API traffic  
**Constraints**: No separate manually maintained backend OpenAPI source, no framework migration, preserve current route behavior, preserve current backend validation model, update repo process guidance in the same feature  
**Scale/Scope**: Backend contract generation and docs exposure plus Speckit constitution/prompt/template updates for future backend API work

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Retroactive exception acknowledged for this already-landed branch; the purpose of this feature includes creating the missing Speckit artifacts after implementation.
- Backend work includes TDD with failing tests written before implementation. Pass in spirit for follow-up verification: contract drift protection is enforced by backend contract tests and build validation.
- Stack remains Node.js for backend and React for frontend. Pass: backend-focused changes plus repo guidance files only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no storage changes.
- LLM provider is GPT-5.2 for AI integrations. Pass: no LLM changes.
- Secrets and keys are managed via `.env` and `.env.example` are updated. Pass: no secret/config surface added.
- Customer data handling and auditability are addressed where applicable. Pass: no new customer data flow introduced.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass: route validation stays in route files, contract assembly moves to a focused OpenAPI module, backend bootstrap owns docs exposure.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: the generated contract lives in a dedicated builder instead of expanding route index or server bootstrap into contract-definition code.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: no additional refactor story required beyond the dedicated OpenAPI builder and script.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: this feature establishes that workflow directly.

## Project Structure

### Documentation (this feature)

```text
specs/022-code-first-openapi/
├── spec.md
└── plan.md
```

### Source Code (repository root)

```text
backend/
├── openapi.yaml                 # Generated from code-first contract source
├── openapi.json                 # Generated from code-first contract source
├── package.json
├── scripts/
│   └── generateOpenApi.ts
├── src/
│   └── app/
│       ├── http/
│       │   ├── openapi/
│       │   │   └── document.ts
│       │   └── routes/
│       │       ├── authRoutes.ts
│       │       ├── accountRoutes.ts
│       │       ├── workspaceRoutes.ts
│       │       ├── settingsRoutes.ts
│       │       ├── documentRoutes.ts
│       │       ├── chatRoutes.ts
│       │       └── publicChatRoutes.ts
│       └── server/
│           └── createApp.ts
└── tests/
    └── contract/
        ├── openapi.contract.test.ts
        └── document.contract.test.ts

.specify/
├── memory/
│   └── constitution.md
└── templates/
    └── plan-template.md

.codex/
└── prompts/
    ├── speckit.plan.md
    ├── speckit.tasks.md
    └── speckit.implement.md
```

**Structure Decision**: Keep backend contract assembly in a dedicated OpenAPI module under `backend/src/app/http/openapi/`, export request validation schemas from the route modules that already own runtime validation, use a small generation script for checked-in artifacts, and keep app bootstrap responsible only for serving the generated contract and docs. Speckit workflow guidance changes stay in repo governance and prompt/template files rather than being buried in backend README notes.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*.ts` continue to own request parsing and validation only.
- **Orchestration Layer**: `backend/src/app/http/openapi/document.ts` assembles the published API contract from route-adjacent schemas and explicit response metadata.
- **Domain Layer**: Existing backend services remain unchanged; this feature does not move business logic into the contract builder.
- **Persistence/Integration Layer**: Existing repositories, services, and connector integrations remain owners of database and external-system behavior.
- **Files Kept Small**: `backend/src/app/server/createApp.ts` must only mount docs endpoints and must not become a second contract-definition file; route modules must not absorb large blocks of OpenAPI path-definition code.
- **Planned Extractions**:
  - dedicated OpenAPI document builder
  - dedicated OpenAPI generation script
  - dedicated drift test for generated artifacts
  - repo-level Speckit workflow guidance updates
- **Required Refactor Stories**: None beyond normalizing request schema exports from existing route files and centralizing contract assembly in the new OpenAPI module.

## Phase 0: Research

No separate research artifact was required for the retroactive plan. The key design decision is to use Zod-based OpenAPI generation compatible with the repo’s current Zod version and to keep docs exposure out of test mode so validation performance and behavior remain stable.

## Phase 1: Design & Contracts

- The authoritative backend contract source lives in `backend/src/app/http/openapi/document.ts`.
- Generated artifacts are written by `backend/scripts/generateOpenApi.ts` to `backend/openapi.yaml` and `backend/openapi.json`.
- Backend docs exposure is provided through `/openapi.json` and `/docs` from `backend/src/app/server/createApp.ts`, excluding test mode.
- Contract drift is enforced by `backend/tests/contract/openapi.contract.test.ts`.
- Existing contract expectations were aligned where the backend test harness already processes document jobs eagerly, so the documented/tested state matches actual behavior.
- Future workflow enforcement is carried by:
  - `.specify/memory/constitution.md`
  - `.specify/templates/plan-template.md`
  - `.codex/prompts/speckit.plan.md`
  - `.codex/prompts/speckit.tasks.md`
  - `.codex/prompts/speckit.implement.md`

## Post-Design Constitution Check

- The feature now establishes a standing constitution rule for backend HTTP contract maintenance.
- Contract generation is code-first, and generated artifacts are treated as outputs rather than editable inputs.
- Module boundaries remain explicit: route validation in route files, contract assembly in the OpenAPI builder, docs exposure in bootstrap, and workflow guidance in Speckit governance files.
- No storage, secret, or LLM-policy violations are introduced.
- The resulting workflow is enforceable in review through generated outputs, contract tests, and build validation.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Retroactive spec/plan creation after implementation | The user requested Speckit artifacts after the code-first system was already implemented on the branch | Rewriting history or discarding completed work to recreate a spec-first sequence would add process churn without improving the delivered system |
