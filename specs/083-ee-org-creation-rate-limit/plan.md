# Implementation Plan: EE Organization Creation Rate Limit

**Branch**: `083-ee-org-creation-rate-limit` | **Date**: 2026-06-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/083-ee-org-creation-rate-limit/spec.md`

## Summary

Add a per-user, per-UTC-calendar-month cap on creating additional organizations in Enterprise Edition. `AuthService.createOrganization` reserves one unit through a new narrow `OrganizationCreationGuard` port before account creation, commits after successful provisioning, and releases only if provisioning rolls back. OSS registers a no-op guard by default; EE registers an enforcing database-backed guard, migrator tables, and admin override routes under the existing usage-limit admin surface.

## Technical Context

**Language/Version**: TypeScript on Node.js 24; React 19 / Next.js 16 for the existing create-organization UI surface  
**Primary Dependencies**: Express, Zod, Pino, PostgreSQL `pg`, Vitest, Supertest, `@asteasolutions/zod-to-openapi`  
**Storage**: PostgreSQL 16, EE-owned `ee_org_creation_counters` and `ee_org_creation_overrides` tables  
**Testing**: Vitest unit and contract tests for green loop; DB-gated integration tests for migrator/concurrency behavior  
**Target Platform**: Radioso backend API and Enterprise backend module  
**Project Type**: Web app with backend, frontend, EE package, docs, and generated OpenAPI artifacts  
**Performance Goals**: One small atomic counter write per successful additional-org creation in EE; no runtime DB work in OSS no-op path  
**Constraints**: Preserve signup behavior; never refund on organization deletion; no raw credentials/session/content in logs or audit metadata; no queue or worker payload changes  
**Scale/Scope**: Per-user monthly velocity meter with flat default limit and per-user override, including unlimited override

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. **Pass**.
- Backend work includes TDD with failing tests written before implementation. **Pass**: unit and contract tests are planned before implementation; DB integration tests are added but not required for green without `INTEGRATION_DATABASE_URL`.
- Frontend user-visible behavior is planned for existing handler coverage only; no new frontend unit tests for CSS/layout. **Pass**.
- Stack remains Node.js for backend and React for frontend. **Pass**.
- Database is PostgreSQL with `pgvector` unchanged. **Pass**.
- LLM provider is not in scope. **Pass**.
- Secrets and keys are managed via `.env`; `.env.example` will add `EE_MAX_ORGS_PER_USER_PER_MONTH`. **Pass**.
- Customer data handling and auditability are addressed with `account.create` failure audit metadata limited to user id, limit, used, periodStart, and resetAt. **Pass**.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. **Pass**.
- Existing responsibility-limited files are identified; `AuthService` remains orchestration-only and does not learn SQL/env/counter details. **Pass**.
- Current structure is clear; no prerequisite refactor story is required. **Pass**.
- Backend app-wide replacement infrastructure is in scope; default OSS wiring belongs in `backend/src/app/composition/` and EE override registration belongs in `ee/packages/backend-module/`. **Pass**.
- Backend HTTP contracts change; update the current code-first OpenAPI sources under `backend/src/app/http/openapi/openApiRegistry.ts` and `backend/src/app/http/openapi/paths/`, then regenerate `backend/openapi.yaml` and `backend/openapi.json`. The older template path `backend/src/app/http/openapi/document.ts` is not present in this worktree. **Pass**.
- Message-queue impact review: **none**. No document worker dispatch, AMQP payload, retry semantics, queue tests, or queue docs change.
- Documentation parity: update `.env.example`, `ee/readme.md`, and operator docs under `docs-portal/content/operators/` for cap behavior, env var, and override API. **Pass**.

## Project Structure

### Documentation (this feature)

```text
specs/083-ee-org-creation-rate-limit/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── org-creation-rate-limit.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/composition/              # Guard registration surface and OSS default wiring
│   ├── app/server/                   # Dependency assembly into AuthService
│   ├── app/http/openapi/             # Code-first OpenAPI source
│   ├── modules/auth/services/        # createOrganization orchestration hook only
│   └── shared/domain/                # OrganizationCreationGuard port and no-op implementation
├── openapi.yaml                      # Generated
├── openapi.json                      # Generated
└── tests/
    ├── unit/
    ├── contract/
    └── integration/

ee/
└── packages/backend-module/src/
    ├── usageLimits/                  # Existing EE admin router, migrator, module registration
    └── orgCreation/                  # EE guard implementation and focused tests

frontend/
└── components/dashboard/             # Existing create-organization error display
```

**Structure Decision**: Use the existing backend/EE/frontend split. The new port is shared domain infrastructure consumed by auth. The enforcing guard is an EE implementation and is wired through the EE module; OSS composition exposes and defaults the port to a no-op.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/accountUserRoutes.ts` continues to translate `POST /account/accounts`; `ee/packages/backend-module/src/usageLimits/usageLimitRoutes.ts` owns EE admin override routes and token guard.
- **Orchestration Layer**: `backend/src/modules/auth/services/authService.ts` resolves the user, reserves through `OrganizationCreationGuard`, performs existing account/workspace/session creation, commits on success, and releases only in the rollback catch path.
- **Domain Layer**: `backend/src/shared/domain/organizationCreationGuard.ts` defines the narrow port and OSS no-op. `ee/packages/backend-module/src/orgCreation/organizationCreationGuard.ts` owns period, env/default/override resolution, atomic reservation, release, and admin override service methods.
- **Persistence/Integration Layer**: `ee/packages/backend-module/src/usageLimits/usageLimitMigrator.ts` owns EE DDL. The EE guard owns SQL against `ee_org_creation_counters` and `ee_org_creation_overrides`.
- **Application Composition**: Add `registerOrganizationCreationGuard` to OSS and EE module contracts. `defaultComposition` exposes the registration; server dependency assembly resolves it to `NoopOrganizationCreationGuard` when absent.
- **Files Kept Small**: `AuthService` must not know counters, UTC month math, SQL, env names, or overrides. `defaultComposition` must only assemble registrations. `usageLimitRoutes.ts` may mount the admin routes but must delegate behavior to the EE org-creation service.
- **Planned Extractions**: New shared guard port; new EE org-creation guard/service module with pure helpers for default limit parsing and period math.
- **Required Refactor Stories**: None.

## Complexity Tracking

No constitution violations.

## Phase 0 Research

See [research.md](./research.md).

## Phase 1 Design

See [data-model.md](./data-model.md), [contracts/org-creation-rate-limit.md](./contracts/org-creation-rate-limit.md), and [quickstart.md](./quickstart.md).

## Post-Design Constitution Check

- TDD remains explicit: backend tests precede implementation tasks.
- Boundaries remain explicit: auth uses only the guard port; EE owns enforcement details; composition owns replaceable runtime wiring.
- API contract work is mapped to the current code-first OpenAPI source files and generated artifacts.
- Message-queue impact remains none.
- Docs parity scope is identified.
