# Implementation Plan: Startup Migration Lock Reliability

**Branch**: `issue-613-spec` | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/078-startup-migration-lock/spec.md`

## Summary

The backend currently runs SQL migrations before binding its HTTP port. In steady state it attempts `CREATE TABLE IF NOT EXISTS schema_migrations` before checking whether the metadata table already exists. During overlapping deploys, that DDL can wait behind a stale lock and produce a silent startup-probe failure.

This feature makes migration startup observable and bounded. The migration module will check for the metadata table with a SELECT first, avoid metadata-table DDL when the table already exists, apply migration-specific lock and statement timeout budgets to metadata checks, and log migration startup failures before the process exits. Worker runtimes remain SELECT-only pending-migration verifiers and use the same bounded metadata-check path.

## Technical Context

**Language/Version**: TypeScript on Node.js 24
**Primary Dependencies**: PostgreSQL `pg` pool/client, Pino application logger, Vitest
**Storage**: PostgreSQL 16 with `pgvector`; `schema_migrations` tracks applied SQL migration files
**Testing**: Vitest unit tests for migration sequencing, database config parsing, and runtime startup behavior; integration tests remain available for broader runtime entrypoints
**Target Platform**: Backend service on Node.js, including Cloud Run deployments and self-hosted Node/container deployments
**Project Type**: Backend runtime feature with operator documentation updates
**Performance Goals**: Steady-state startup must avoid metadata-table DDL and blocked migration startup must fail within 30 seconds in covered tests
**Constraints**: Migrations must still complete before the API binds its HTTP port; workers must not apply SQL migrations; logs must not expose connection strings or secrets
**Scale/Scope**: One backend runtime startup path, one shared migration module, worker pending-migration verification checks, and deployment/self-hosting docs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. PASS.
- Backend work includes TDD with failing tests written before implementation. PASS: tasks require Vitest tests before code changes.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. Not applicable; no frontend work.
- Stack remains Node.js for backend and React for frontend. PASS.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. PASS.
- LLM provider is GPT-5.2 for AI integrations. Not applicable; no AI integration changes.
- Secrets and keys are managed via `.env` and `.env.example` is updated. PASS: a new non-secret timeout knob is planned in env parsing and `.env.example`.
- Customer data handling and auditability are addressed where applicable. PASS: migration logs exclude connection strings and sensitive SQL parameter values.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. PASS.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. PASS.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. PASS: no structural blocker found.
- If backend work adds or replaces app-wide adapters, registries, sinks, lifecycle hooks, capability policies, storage/dispatcher implementations, or cross-module runtime infrastructure, the plan evaluates `backend/src/app/composition/` ownership and keeps domain rules in modules/shared domain files. PASS: composition is not in scope because this is not replaceable app-wide infrastructure wiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. PASS: no backend HTTP contract changes.
- If public APIs, SDK contracts, MCP contracts, connector contracts, worker payloads, or other cross-service contracts change, the plan includes a message-queue impact review covering document worker dispatch, AMQP queue payloads, retry semantics, queue tests, and queue docs. PASS: no cross-service contract changes; message-queue impact is documented as unaffected.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. PASS: deployment and self-hosting operations docs are in scope.

## Project Structure

### Documentation (this feature)

```text
specs/078-startup-migration-lock/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

No `contracts/` directory is planned because the feature does not change public HTTP APIs, SDKs, MCP, connectors, or worker queue payloads.

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/config/env.ts
│   ├── db/runMigrations.ts
│   ├── runtime/startApiRuntime.ts
│   ├── runtime/startWorkerRuntime.ts
│   └── shared/infra/database.ts
└── tests/
    └── unit/
        ├── database-config.test.ts
        ├── run-migrations.test.ts
        └── runtime-startup.test.ts

docs-portal/
└── content/operators/
    ├── deployment.mdx
    └── self-hosting-operations.mdx

.env.example
```

**Structure Decision**: Keep migration-specific rules in `backend/src/db/runMigrations.ts` and a small focused helper module only if tests show `runMigrations.ts` would mix unrelated concerns. Keep `backend/src/runtime/startApiRuntime.ts` as startup orchestration only. Keep generic pool options in `backend/src/shared/infra/database.ts`; it may expose `lock_timeout` as a generic PostgreSQL option but must not know what migrations are.

## Module Ownership & Seams

- **Transport Layer**: Not applicable; no HTTP route or OpenAPI behavior changes.
- **Orchestration Layer**: `backend/src/runtime/startApiRuntime.ts` sequences migrations before dependency construction and HTTP listen. It may log that startup migrations begin/fail, but it must not inline migration SQL or diagnostic queries.
- **Domain Layer**: `backend/src/db/runMigrations.ts` owns migration discovery, metadata table existence checks, metadata initialization, pending migration application, and migration-specific timeout defaults/options.
- **Persistence/Integration Layer**: `backend/src/shared/infra/database.ts` owns generic PostgreSQL pool configuration and query helpers. It can support a generic lock timeout option for PostgreSQL clients.
- **Application Composition**: N/A. No default adapter, registry, lifecycle hook, capability policy, storage implementation, or dispatcher implementation is added or replaced.
- **Files Kept Small**: `startApiRuntime.ts` remains orchestration-only; `Database` remains a generic wrapper; worker runtime files remain pending-migration verification callers only.
- **Planned Extractions**: Add focused migration startup option types/helpers in or near `runMigrations.ts` if needed for testable timeout policy and error classification.
- **Required Refactor Stories**: None. Existing seams are adequate for the fix.

## Complexity Tracking

No constitution violations are planned.

## Phase 0 Research

See [research.md](./research.md).

## Phase 1 Design

See [data-model.md](./data-model.md) and [quickstart.md](./quickstart.md).

## Message-Queue Impact Review

No document worker dispatch, AMQP payload shape, retry semantics, queue tests, or queue docs are affected. The feature only changes backend startup SQL migration behavior and operator documentation. Worker runtimes continue to perform pending-migration verification and do not consume or publish queue messages differently.

## Post-Design Constitution Check

- Backend TDD remains required and is reflected in `tasks.md`.
- No public HTTP, SDK, MCP, connector, or queue contract changes are introduced.
- No OpenAPI generation tasks are required.
- No `backend/src/app/composition/` changes are required.
- Docs updates are required in `docs-portal/content/operators/deployment.mdx` and `docs-portal/content/operators/self-hosting-operations.mdx`.
- `.env.example` must include the new migration timeout knob if implementation adds one.
