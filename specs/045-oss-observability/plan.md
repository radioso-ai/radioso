# Implementation Plan: OSS Observability

**Branch**: `045-oss-observability` | **Date**: 2026-04-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/045-oss-observability/spec.md`

## Summary

Introduce a first-party observability architecture for Radioso that keeps
structured logs and audit persistence as the default OSS foundation, adds
vendor-neutral telemetry and metrics seams, normalizes product analytics and
incident events behind Radioso-owned interfaces, and allows optional SaaS-only
adapters without making vendor SDKs part of shared product code. The initial
implementation should be backend-first, preserve existing module boundaries,
and roll out in phases so error capture, telemetry emission, metrics exposure,
and optional sink fan-out can be verified independently.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend for later analytics emitters only)  
**Primary Dependencies**: Express, `pg`, Pino, Zod, OpenAI SDK, Vitest, Supertest, existing audit and retrieval modules; planned vendor-neutral telemetry and metrics libraries only when implementation begins  
**Storage**: PostgreSQL 16 with `pgvector`; existing `audit_events` as the initial durable event sink; no new external storage required for the planning phase  
**Testing**: Vitest unit and integration tests in `backend/tests`, runtime configuration regression coverage, and targeted route/runtime verification for metrics and incident capture paths  
**Target Platform**: Linux container runtime for backend API and worker services, with optional hosted SaaS exporters and self-hosted OSS deployments  
**Project Type**: Web application with `backend/`, `frontend/`, `docs/`, and `specs/`  
**Performance Goals**: Observability emission must remain non-blocking on request and worker critical paths; optional external sinks must degrade safely; metrics exposure and incident capture must not materially regress API latency  
**Constraints**: No mandatory PostHog or Sentry dependency in OSS defaults; no sink-specific calls in shared route or orchestration modules; no raw prompts, retrieved document text, secrets, or connector credentials exported by default; backend-first rollout; no public API contract changes required for the first implementation slice  
**Scale/Scope**: Cross-cutting backend architecture work touching shared observability, audit persistence, runtime configuration, dependency wiring, error handling, and later optional frontend analytics emitters for user actions such as citation clicks

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/045-oss-observability/`.
- Backend work includes TDD with failing tests written before implementation. Pass: the task plan requires backend red-green coverage for observability seams before wiring runtime composition.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database remains PostgreSQL with `pgvector`. Pass; initial durable storage reuses `audit_events` and existing repositories.
- LLM provider defaults remain unchanged. Pass; this feature does not modify model-facing runtime behavior.
- Secrets and keys stay in `.env` and `.env.example`. Pass; any future exporter credentials are optional and must be documented there.
- Customer data handling and auditability are addressed. Pass; the design requires redaction and field-level export rules before any optional sink fan-out.
- Module boundaries are explicit: HTTP transport remains thin, composition stays in `backend/src/app/server/`, focused observability modules own telemetry, analytics, and incidents, and repositories remain persistence-only.
- Responsibility-limited files are identified. Pass: `backend/src/app/server/createApp.ts`, `backend/src/app/server/dependencies.ts`, `backend/src/modules/chat/services/chatService.ts`, and `backend/src/modules/audit/services/auditService.ts` must stay focused.
- If structure is unclear or files are already too large, the plan adds extraction stories first. Pass: the first implementation slice introduces dedicated seams rather than extending existing god files.
- Backend HTTP contracts do not change in the first rollout slice, so no code-first OpenAPI updates are required initially. If a later phase adds operator-facing endpoints, those changes must land in `backend/src/app/http/openapi/document.ts` with generated outputs refreshed.
- Contracts, workflows, settings behavior, or user-visible functionality that change must update docs in the same delivery. Pass: `docs/`, `readme.md`, and `backend/.env.example` are identified for future implementation updates when config and operator workflow change.

**Post-design check**: Pass. The design preserves existing backend composition seams and introduces focused modules for telemetry, product analytics, and incident reporting before any sink-specific integration is attempted.

## Project Structure

### Documentation (this feature)

```text
specs/045-oss-observability/
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
│   │   │   ├── middleware/
│   │   │   ├── openapi/
│   │   │   └── routes/
│   │   └── server/
│   ├── db/repositories/
│   ├── modules/
│   │   ├── audit/services/
│   │   ├── chat/services/
│   │   ├── documents/services/
│   │   └── retrieval/services/
│   └── shared/
│       ├── domain/
│       ├── infra/
│       └── observability/
├── tests/
│   ├── integration/
│   └── unit/
└── .env.example

frontend/
├── components/dashboard/
├── lib/
└── tests/unit/

docs/
├── README.md
└── oss-saas-observability.md

readme.md
```

**Structure Decision**: Keep runtime composition in `backend/src/app/server/`
and keep transport logic inside route and middleware files. Introduce new
backend-first seams under `backend/src/shared/observability/`,
`backend/src/shared/analytics/`, and `backend/src/shared/incidents/` so shared
services emit Radioso-owned events without depending on vendor SDKs. Reuse
`backend/src/modules/audit/services/auditService.ts` and
`backend/src/db/repositories/auditEventRepository.ts` as the first durable event
sink, while keeping future frontend analytics emitters isolated to dedicated
client-side modules instead of embedding sink logic inside UI components.

## Module Ownership & Seams

- **Transport Layer**:
  - `backend/src/app/http/routes/*.ts`
  - `backend/src/app/http/middleware/errorHandler.ts`
  - future metrics route wiring in the HTTP layer only
- **Orchestration Layer**:
  - `backend/src/app/server/dependencies.ts`
  - `backend/src/app/server/createApp.ts`
  - existing service orchestrators such as chat, documents, and retrieval
- **Domain Layer**:
  - new telemetry emission interfaces and correlation helpers
  - new product analytics event taxonomy and emission service
  - new incident normalization and reporting service
- **Persistence/Integration Layer**:
  - `backend/src/db/repositories/auditEventRepository.ts`
  - optional sink adapters for metrics exporters, analytics exporters, and incident exporters
  - runtime configuration in `backend/src/app/config/`
- **Files Kept Small**:
  - `backend/src/app/server/createApp.ts`
  - `backend/src/app/server/dependencies.ts`
  - `backend/src/modules/chat/services/chatService.ts`
  - `backend/src/modules/audit/services/auditService.ts`
  - `backend/src/app/http/middleware/errorHandler.ts`
- **Planned Extractions**:
  - `backend/src/shared/observability/telemetry/*`
  - `backend/src/shared/analytics/*`
  - `backend/src/shared/incidents/*`
  - optional `backend/src/integrations/posthog/*` and `backend/src/integrations/sentry/*`
  - a dedicated metrics presentation module if `/metrics` is added
- **Required Refactor Stories**:
  - replace ad hoc unhandled-error logging with a dedicated incident reporting seam before adding external incident sinks
  - route product-event emission through a focused service before adding any vendor adapter
  - add correlation and redaction helpers before broadening telemetry coverage across chat, retrieval, and ingestion flows

## Phase 0: Research

- Completed in [research.md](./research.md).

## Phase 1: Design & Contracts

- The observability entities, lifecycle boundaries, and sink relationships are defined in [data-model.md](./data-model.md).
- Verification and rollout checkpoints are documented in [quickstart.md](./quickstart.md).
- No design-time HTTP contract artifact is required in this phase because the first implementation slice is backend-internal and does not require public API changes.
- If later phases add operator-facing metrics or event-inspection endpoints, the implementation must update `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml` and `backend/openapi.json` remain generated outputs only.
- No backend runtime prompt assets are expected for this feature.
- Agent context update must be run via `.specify/scripts/bash/update-agent-context.sh codex`.

## Phase 2: Implementation Strategy

1. Add focused backend seams for telemetry, product analytics, and incident reporting with default no-op or first-party implementations.
2. Replace ad hoc unhandled-error capture with normalized incident reporting and structured logger integration.
3. Add OSS-safe runtime telemetry and metrics exposure, including correlation helpers and redaction rules.
4. Route existing domain events and new product events through the internal analytics seam, using audit storage as the first durable sink.
5. Add optional sink adapters and configuration gates only after default-first behavior is fully tested and documented.
6. Add narrow frontend analytics emitters only for user interactions that cannot be observed from the backend, keeping sink logic outside presentation components.
7. Update operator and run-flow docs once runtime configuration and supported deployment patterns are finalized.

## Post-Design Constitution Check

- Backend TDD remains enforceable because telemetry, analytics, and incident reporting each have isolated seams suitable for unit and integration tests. Pass.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 constraints remain unchanged. Pass.
- No initial public HTTP contract change is required, so OpenAPI ownership remains unchanged in the first slice. Pass.
- Prompt ownership constraints are unaffected because no runtime prompt assets are planned. Pass.
- Module ownership improves rather than degrades: runtime composition stays thin, repositories stay persistence-only, and sink-specific integrations are quarantined behind optional adapters. Pass.
- Documentation parity is preserved because the plan explicitly calls out `docs/oss-saas-observability.md`, `docs/README.md`, `readme.md`, and `.env.example` for future implementation updates when behavior changes. Pass.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
