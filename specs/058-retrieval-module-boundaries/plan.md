# Implementation Plan: Retrieval Module Boundaries

**Branch**: `058-retrieval-module-boundaries` | **Date**: 2026-05-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/058-retrieval-module-boundaries/spec.md`

## Summary

Introduce a retrieval module public surface and enforce it as the only production import path for retrieval-owned symbols outside `backend/src/modules/retrieval/**`. The implementation adds `backend/src/modules/retrieval/public.ts`, migrates production consumers to import from it, adds dependency-cruiser boundary enforcement with backend scripts and CI wiring, documents the public-surface pattern, and preserves all runtime, API, SDK, MCP, database, queue, prompt, and frontend behavior.

## Technical Context

**Language/Version**: TypeScript on Node.js 24
**Primary Dependencies**: Express backend, Vitest/Supertest, TypeScript compiler, dependency-cruiser for source boundary validation
**Storage**: PostgreSQL with `pgvector` remains unchanged; no schema or persistence change
**Testing**: Vitest unit/composition tests, `npm run build`, dependency-cruiser boundary lint
**Target Platform**: Backend Node.js server and worker runtimes in local, self-hosted, and CI environments
**Project Type**: Web application with backend-focused architecture refactor
**Performance Goals**: No runtime performance change; boundary lint should complete within normal backend CI budget
**Constraints**: No REST API, OpenAPI, SDK, MCP, database schema, worker queue, prompt asset, or frontend route changes; tests excluded from first-pass boundary enforcement
**Scale/Scope**: Retrieval pilot only; production imports from app composition, chat, documents, audit, settings, database, and shared LLM infrastructure are in scope

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. **PASS**: `specs/058-retrieval-module-boundaries/spec.md` exists and the user approved proceeding.
- Backend work includes TDD with failing tests written before implementation. **PASS**: add the dependency-cruiser config and validate it fails before migrating direct imports, then migrate code to green.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. **PASS**: no frontend user-visible behavior is in scope.
- Stack remains Node.js for backend and React for frontend. **PASS**: backend TypeScript/Node.js only; frontend untouched.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. **PASS**: no database change.
- LLM provider is GPT-5.2 for AI integrations. **PASS**: no runtime LLM integration behavior or prompt assets change.
- Secrets and keys are managed via `.env` and `.env.example` is updated. **PASS**: no new secrets or configuration values.
- Customer data handling and auditability are addressed where applicable. **PASS**: import-boundary refactor does not expand customer data access.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. **PASS**: retrieval public surface owns cross-module access; internals remain private.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. **PASS**: boundary config remains focused; composition remains wiring-only; retrieval public surface is an export contract, not a behavior owner.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. **PASS**: no broad refactor story required; the seam is the new public entrypoint.
- If backend work adds or replaces app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or cross-module runtime infrastructure, the plan evaluates `backend/src/app/composition/` ownership and keeps domain rules in modules/shared domain files. **PASS**: app composition imports are migrated through the retrieval public surface, but no new runtime adapter or registry is introduced.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. **PASS**: no HTTP contract change.
- If public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, or other cross-service contracts change, the plan includes a message-queue impact review covering document worker dispatch, AMQP queue payloads, retry semantics, queue tests, and queue docs. **PASS**: message-queue impact review below states no cross-service contract change.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. **PASS**: architecture documentation is updated because the maintainer-facing pattern changes.

## Project Structure

### Documentation (this feature)

```text
specs/058-retrieval-module-boundaries/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── retrieval-public-surface.md
├── tasks.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── dependency-cruiser.config.cjs
├── package.json
├── package-lock.json
├── src/
│   ├── app/
│   │   ├── composition/defaultComposition.ts
│   │   ├── http/
│   │   │   ├── openapi/document.ts
│   │   │   ├── presenters/chatPresenter.ts
│   │   │   └── routes/
│   │   └── server/
│   ├── db/
│   ├── modules/
│   │   ├── audit/
│   │   ├── chat/
│   │   ├── documents/
│   │   ├── retrieval/
│   │   │   ├── public.ts
│   │   │   ├── domain/
│   │   │   ├── infra/
│   │   │   └── services/
│   │   └── settings/
│   └── shared/infra/llm/
└── tests/

docs/
└── architecture-extension-points.md

.github/workflows/
└── ci.yml
```

**Structure Decision**: Backend-only import-boundary feature. The retrieval module owns explicit root-level production entry points: `public.ts` for chat-safe contracts/helpers, `composition.ts` for app wiring, and `llmAdapters.ts` for provider registration. Existing production consumers keep their current behavior but route imports through an approved entry point. Boundary enforcement belongs to backend tooling and CI. Documentation updates stay in `docs/architecture-extension-points.md`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/**` may import retrieval contracts for schemas, presenters, and route adaptation only through the retrieval public surface.
- **Orchestration Layer**: Chat, document, audit, settings, and app server services may coordinate with retrieval services only through intentionally exported retrieval contracts.
- **Domain Layer**: `backend/src/modules/retrieval/domain/**` remains retrieval-owned and private to production consumers outside retrieval unless symbols are promoted through an approved retrieval root entry point.
- **Persistence/Integration Layer**: `backend/src/modules/retrieval/infra/**` and retrieval LLM gateway adapters remain retrieval-owned. External production consumers may use only explicitly exported adapters or ports through approved retrieval root entry points.
- **Application Composition**: `backend/src/app/composition/defaultComposition.ts` should import retrieval chunking strategy construction through `composition.ts`. No new app-wide adapter, registry, lifecycle hook, capability policy, storage implementation, or dispatcher is introduced.
- **Files Kept Small**: `backend/src/modules/retrieval/public.ts` must remain a curated export list, not a behavior module. `backend/dependency-cruiser.config.cjs` must remain focused on retrieval boundary enforcement. HTTP routes and presenters must not become retrieval policy owners. Composition must remain default wiring only.
- **Planned Extractions**: New retrieval root entry points and new backend dependency-cruiser config.
- **Required Refactor Stories**: None. The existing structure has clear retrieval domain/service/infra folders and enough production consumers to justify a public entrypoint directly.

## Message-Queue Impact Review

This feature changes import paths and source-boundary validation only. It does not change public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, document worker dispatch behavior, AMQP queue payload shape, retry semantics, queue tests, or queue documentation. No queue follow-up tasks are required.

## Phase 0 Research Summary

Research resolved that dependency-cruiser is appropriate for a strict source import boundary because it can target TypeScript imports, distinguish source path scopes, and run in CI as a local backend script. The pilot should enforce production source only and exclude tests, generated OpenAPI output, and built output. The public surface should use re-exports so it does not own product logic.

## Phase 1 Design Summary

The feature adds a single internal architecture contract, documented in `contracts/retrieval-public-surface.md`. There are no HTTP contracts, data migrations, prompt assets, or frontend surfaces. The data model is conceptual only and captured in `data-model.md`.

## Complexity Tracking

No constitution violations require justification.

## Post-Design Constitution Check

- Spec-first gate remains satisfied.
- Backend TDD is represented by red-first boundary lint validation before the import migration.
- No frontend, database, LLM prompt, secret, public API, SDK, MCP, worker queue, or schema changes are introduced.
- Modularity is strengthened by making retrieval cross-module ownership explicit and CI-enforced.
- Documentation parity is satisfied by updating the architecture extension-points documentation after reading `docs/document-writer-prompt.md`.
