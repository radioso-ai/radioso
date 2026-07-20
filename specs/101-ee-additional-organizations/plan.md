# Implementation Plan: Enterprise Multi-Organization Creation

**Branch**: `move-multi-org-to-ee` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)
**Input**: Approved feature specification from `/specs/101-ee-additional-organizations/spec.md`

## Summary

Make organization creation an edition-owned policy. The OSS policy permits one deployment-wide bootstrap signup by holding a namespaced PostgreSQL session advisory lock on a pinned Kysely connection, checking organization existence on that connection, and running the core provisioning transaction on that same connection. A narrow PostgreSQL provisioner atomically commits the account, new user when applicable, owner membership, and default workspace, so interruption cannot strand partial bootstrap state. Enterprise replaces the policy through application composition: signup remains open and signed-in additional organization creation keeps the existing per-user monthly reservation counter. Auth orchestration uses the policy and provisioner for password registration, new federated-account provisioning, and signed-in creation; every orderly post-reservation failure releases capacity and uses the existing account-delete compensation for post-transaction effects. A public read-only registration-availability route drives a retry-capable auth UI, while a frontend edition capability removes only the additional-organization action and leaves workspace creation unchanged.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24; React 19 and Next.js 16
**Primary Dependencies**: Express, Zod, Kysely/pg, Radix UI, generated OpenAPI types
**Storage**: PostgreSQL 16; no schema change, using a session advisory lock plus the existing `accounts` table
**Testing**: Vitest, Supertest, PostgreSQL integration tests, Playwright
**Target Platform**: Self-hosted OSS and Enterprise web deployments
**Project Type**: Web application with OSS backend/frontend and optional EE backend module
**Performance Goals**: One non-blocking advisory-lock attempt plus one organization-existence read for registration availability; one pinned pooled connection held only during first-organization provisioning
**Constraints**: Server-authoritative; multi-process concurrency safe; crash-atomic core provisioning; no new table or migration; no customer content in denial audit metadata; no OSS migration compatibility required
**Scale/Scope**: One organization-creation policy, three provisioning paths, two HTTP routes, one auth screen, one organization switcher, and supporting docs/tests

## Constitution Check

*GATE: Passed before research and re-checked after design.*

- The user approved `spec.md` on 2026-07-20; its status is recorded as Approved.
- Backend implementation is test-first. Unit/contract/integration tests for reservation lifecycle, concurrent bootstrap, denials, and availability are written and observed failing before production code changes.
- User-visible auth and switcher behavior uses Playwright; edition-controller unit coverage is limited to non-visual capability logic.
- The stack remains Node.js, TypeScript, React, and PostgreSQL; no LLM behavior, provider, secret, or new configuration is introduced.
- Denied attempts emit fixed reason codes and actor IDs only. Organization names, email addresses, credentials, sessions, and request content are excluded.
- `AuthService` remains orchestration-only. The narrow policy owns edition/initialization decisions, an auth-owned infrastructure adapter owns SQL reservation persistence, and routes only map results.
- A built-in auth application module registers the OSS advisory-lock policy factory in `backend/src/app/composition/`; the EE module continues to override that registration. Composition contains no product rules.
- `backend/src/app/http/openapi/document.ts` remains the code-first document entry point through its existing path/schema registries. Generated `backend/openapi.yaml` and `backend/openapi.json` are regenerated, never hand-edited.
- Message-queue impact: none. The changed auth/account HTTP behavior and new read-only endpoint do not touch document worker dispatch, AMQP payloads, queue retries, SDK semantics, MCP contracts, or connector contracts. No queue tests or queue docs are required.
- API, setup, auth, and Enterprise limit documentation are updated in the same change after reading `docs/document-writer-prompt.md`.

## Project Structure

### Documentation (this feature)

```text
specs/101-ee-additional-organizations/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/auth-registration.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/modules/auth/                 # policy implementation and provisioning orchestration
├── src/app/composition/              # OSS default registration; EE override seam
├── src/app/http/routes/              # runtime routes and Zod request schemas
├── src/app/http/openapi/              # code-first schemas and path registration
├── tests/unit/                        # orchestration and composition tests
├── tests/contract/                    # response/status contract tests
└── tests/integration/                 # real-Postgres concurrency and invitation/workspace journeys
ee/packages/backend-module/src/
├── orgCreation/                       # monthly additional-organization policy
└── usageLimits/applicationModule.ts   # Enterprise policy override
frontend/
├── components/auth/                   # availability-aware auth experience
├── components/dashboard/              # edition-aware organization switcher
├── lib/                               # API adapter and edition capability
├── tests/unit/                        # API/capability logic only
└── tests/e2e/                          # visible auth and switcher journeys
docs-portal/content/                    # public setup, auth, and operator docs
```

**Structure Decision**: Auth owns the feature because all organization provisioning already runs through `AuthService`. The policy contract remains shared with EE, its OSS SQL implementation stays inside the auth module, and application composition selects OSS versus Enterprise behavior. Workspace services and routes are not coupled to organization limits.

## Module Ownership & Seams

- **Transport Layer**: `authRoutes.ts` exposes registration availability and maps register errors; `accountUserRoutes.ts` continues to map signed-in organization creation. Neither counts organizations or decides edition behavior.
- **Orchestration Layer**: `authService.ts` reserves, invokes one core provisioner, runs post-transaction hooks/session/audit, commits or releases the policy reservation, and requests compensation for orderly post-commit failures. It does not query PostgreSQL policy state or thread transaction handles.
- **Domain Layer**: `organizationCreationGuard.ts` defines intent-aware reservation and availability ports plus inert Enterprise-compatible behavior. The OSS implementation decides bootstrap availability and stable denial semantics.
- **Persistence/Integration Layer**: An auth-owned PostgreSQL bootstrap adapter pins one Kysely connection, acquires/unlocks a fixed namespaced session advisory lock, checks existing organizations, and runs the core transaction on that same connection before returning it to the pool. A separate narrow provisioner adapter creates transaction-scoped existing repositories/services and atomically persists the core organization graph. PostgreSQL rolls back an interrupted core transaction and releases the session lock automatically if its connection dies. The same-connection boundary avoids deadlock when the configured pool size is one.
- **Application Composition**: A built-in auth module registers the OSS guard factory. `usageLimits/applicationModule.ts` overrides the guard in EE, as it does today.
- **Files Kept Small**: Routes remain request/response adapters; `workspaceService` and workspace routes remain organization-policy unaware; EE guard remains monthly-counter focused; `defaultComposition.ts` only adds one module registration.
- **Planned Extractions**: Add an auth-owned OSS policy/lock adapter, a core organization provisioner port with a PostgreSQL unit-of-work adapter, and an auth composition factory instead of embedding SQL, transaction plumbing, or edition checks in `AuthService` or routes.
- **Required Refactor Stories**: None. Existing policy and composition seams are sufficient; only the reservation lifecycle in `AuthService` is tightened so account persistence is inside the release-protected block.

## Complexity Tracking

No constitution violations require justification.
