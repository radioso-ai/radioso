# Implementation Plan: Modular Extension Points

**Branch**: `054-modular-extension-points` | **Date**: 2026-05-02 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/belo-horizonte/specs/054-modular-extension-points/spec.md)
**Input**: Feature specification from `/specs/054-modular-extension-points/spec.md`

## Summary

Prepare Radioso for explicit modular composition while preserving current default behavior. The implementation will introduce a focused application module/composition layer, a neutral capability policy, and default-build verification. Existing connector, observability, incident, document storage, worker dispatch, and retrieval seams will be reused where sufficient and strengthened where they currently live directly inside broad dependency wiring.

The highest-risk area is `backend/src/app/server/dependencies.ts`, which currently owns most object construction, adapter selection, sink construction, built-in connector registration, and retrieval pipeline assembly. The plan extracts registration and adapter-selection concerns into focused modules so the file remains a composition coordinator rather than a permanent home for every deployment decision.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend packages; TypeScript 5.7 with React 19 and Next.js 16 for frontend if UI visibility is needed
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing local packages under `packages/`
**Storage**: PostgreSQL 16 with `pgvector`; no new persisted data is planned for this feature
**Testing**: Vitest for backend unit/integration tests; existing backend build scripts; Playwright only if planning discovers user-visible frontend behavior
**Target Platform**: Local/self-hosted Docker development, backend API runtime, document worker runtime, worker task runtime, frontend dashboard, CI validation
**Project Type**: Web application with backend, frontend, packages, docs, and Speckit artifacts
**Performance Goals**: Default startup and request paths must not add external calls or material latency; capability checks must be in-process and constant-time for the default policy
**Constraints**: Preserve current user-facing behavior; default build must not require optional modules or new required environment variables; no runtime LLM prompt changes; no mandatory external services for default local/self-hosted runs
**Scale/Scope**: Architecture-preparation feature touching backend composition, focused tests, CI/build validation, and maintainer/operator docs; no new data model migration expected

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. **PASS** — approved `specs/054-modular-extension-points/spec.md`.
- Backend work includes TDD with failing tests written before implementation. **PASS** — tasks must write composition, module-registration, and capability-policy tests before implementation.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. **PASS** — no frontend UI is expected; if module status visibility is added, Playwright coverage is required.
- Stack remains Node.js for backend and React for frontend. **PASS** — no stack change.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. **PASS** — no database change planned.
- LLM provider is GPT-5.2 for AI integrations. **PASS** — no LLM integration change planned.
- Secrets and keys are managed via `.env` and `.env.example` is updated. **PASS** — no new required env vars planned; optional env changes, if introduced, must update examples.
- Customer data handling and auditability are addressed where applicable. **PASS** — module initialization and capability-denial errors must avoid exposing secrets/customer data and use existing operational logging.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. **PASS** — see Module Ownership & Seams.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. **PASS** — `dependencies.ts`, route files, orchestration services, and frontend components are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. **PASS** — Foundational tasks will extract composition types and default registries before wiring user stories.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. **PASS** — no public HTTP contract changes are planned; if capability-denial responses require route-level contract changes, OpenAPI work is mandatory.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. **PASS** — docs updates are required for extension model and build verification.

## Project Structure

### Documentation (this feature)

```text
specs/054-modular-extension-points/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── extension-boundaries.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── composition/              # New module registration, default module bundle, capability catalog/policy
│   │   ├── server/dependencies.ts    # Remains the high-level dependency assembler
│   │   ├── server/types.ts           # Adds composition/capability dependencies where needed
│   │   ├── http/routes/              # May call capability policy for representative guarded actions only
│   │   └── worker/                   # Uses default worker-dispatch composition where needed
│   ├── modules/
│   │   ├── connectors/               # Existing connector registry remains connector-focused
│   │   ├── documents/                # Storage and worker-dispatch ports remain focused here
│   │   ├── retrieval/                # Retrieval strategy/stage boundaries remain focused here
│   │   ├── settings/                 # Settings orchestration remains settings-focused
│   │   └── security/                 # Abuse control remains separate from neutral capability policy
│   └── shared/
│       ├── analytics/                # Existing sink contracts remain analytics-focused
│       ├── incidents/                # Existing sink contracts remain incident-focused
│       └── observability/            # Existing telemetry contracts remain telemetry-focused
├── tests/
│   ├── unit/                         # Composition, registry, and policy tests
│   ├── integration/                  # Default composition/startup regression tests where practical
│   └── contract/                     # Only if HTTP contract changes become necessary
└── package.json

docs/
├── README.md                         # Index extension-model documentation if appropriate
└── architecture-extension-points.md   # New or updated maintainer/operator architecture guide

.github/workflows/
└── [existing workflow or new validation workflow]
```

**Structure Decision**: Use the existing backend/server/runtime structure and add a focused `backend/src/app/composition/` area for application module definitions, default registrations, and capability policy primitives. Do not introduce a separate package for this feature. Keep existing domain-specific ports in their current modules when they already exist, such as connector plugins, document storage, document job dispatch, analytics sinks, incident sinks, and telemetry sinks.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/*`, `backend/src/app/http/middleware/*`, `backend/src/app/server/createApp.ts`, and `backend/src/app/worker/*` translate requests, attach middleware, and shape responses. They may consult capability policy for representative guarded operations but must not own module registration or adapter construction.
- **Orchestration Layer**: `backend/src/app/server/dependencies.ts`, runtime startup files, and high-level services under `backend/src/modules/**/services/*` coordinate workflows. `dependencies.ts` may assemble the final dependency graph, but adapter selection and default module registration should move into focused composition helpers.
- **Domain Layer**: `backend/src/app/composition/*` owns application module contracts, capability names, default allow policy, duplicate registration behavior, and test-only strict policy. Existing domain modules own their specific rules, such as retrieval stages, connector contracts, and settings validation.
- **Persistence/Integration Layer**: Repositories under `backend/src/db/repositories/*`, storage adapters under `backend/src/modules/documents/infra/*`, search adapters under `backend/src/modules/retrieval/infra/*`, and sink adapters under `backend/src/shared/**` remain responsible for external systems and persistence.
- **Files Kept Small**: `backend/src/app/server/dependencies.ts`, `backend/src/app/server/createApp.ts`, `backend/src/app/http/routes/index.ts`, route files, `ChatService`, `RetrievalPipelineService`, `DocumentProcessingWorker`, frontend page/components, and sink implementations must not absorb optional-module registration logic.
- **Planned Extractions**: Create composition helpers for default module registration, capability catalog/policy, connector registration, sink bundle registration, document storage selection, document job dispatcher selection, and retrieval-stage strategy construction where current code is embedded directly in `dependencies.ts`.
- **Required Refactor Stories**: Before user-story wiring, extract the minimal composition and capability primitives needed to keep `dependencies.ts` from growing. Full extraction of every existing dependency is not required; focus on the extension categories named in the spec and preserve behavior first.

## Complexity Tracking

No constitution violations are planned.
