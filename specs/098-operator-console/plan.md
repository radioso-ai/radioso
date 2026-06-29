# Implementation Plan: Operator Console — Customer & Usage-Tier Administration

**Branch**: `admin-customer-administration-design` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/098-operator-console/spec.md`

## Summary

Build an EE staff-facing Operator Console for administering customer
**organizations** (= `accounts`) and their **usage tiers**, on a staff authority
axis fully separate from customer sessions. The backend half (list/create/edit
tiers, change tier per org, per-org usage) already exists in the
`radioso-enterprise-usage-limits` module; this feature adds (a) a **staff
identity + role + session** subsystem, (b) an **organization directory** read
path (the one missing query), (c) **audit** on every mutation, (d) a
**break-glass owner bootstrap** gated by `EE_USAGE_ADMIN_TOKEN`, and (e) a new
**EE frontend package** rendering the console. All new code lives in `ee/`; the
OSS build remains free of any reference to it.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24 (backend), React 19 / Next.js 16 App Router (frontend)
**Primary Dependencies**: Express, Kysely (EE Kysely on the OSS-owned `pg.Pool`), Zod, `bcryptjs`, `node:crypto`, Radix/shadcn via `@radioso/ui`, Pino
**Storage**: PostgreSQL 16. New EE relational tables `ee_staff_users`, `ee_staff_sessions`. **No `pgvector`/embeddings** — this feature is purely relational (noted as an intentional deviation from the vector-search constitution line, which is about embeddings, not all features).
**Testing**: Vitest + Supertest (backend, TDD), Playwright (operator journeys), Vitest (frontend non-visual logic only)
**Target Platform**: Linux server (backend), browser (console)
**Project Type**: Web (EE backend module + new EE frontend package)
**Performance Goals**: Org directory first page returns quickly at expected org counts; per-row usage kept cheap (one headline figure, no 4-resource computation per row — SC-007)
**Constraints**: Staff axis must not commingle with customer sessions; default-deny by role; EE/OSS boundary intact; audit on all mutations
**Scale/Scope**: Internal operator tool; tens of staff, thousands of orgs. ~2 new backend tables, ~1 new backend module, ~1 new frontend package, ~3 console screens.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec approved**: Yes — reviewed over two rounds, all findings resolved, no open `[NEEDS CLARIFICATION]`. ✅
- **TDD (backend)**: Each backend slice writes failing Vitest/Supertest tests first (staff auth, role gating, org directory, audit emission, bootstrap). ✅
- **Frontend testing**: Operator journeys (login, directory, change tier, create tier, role-gating) covered by Playwright; Vitest limited to byte-unit formatting + API adapters. No markup/class assertions. ✅
- **Stack**: Node.js backend, React frontend. ✅
- **Database**: PostgreSQL. Relational only — `pgvector` N/A (no embeddings in this feature). Deviation noted, not a violation of intent.
- **LLM provider**: N/A — no LLM usage; no conversational copy generated. Operator-UI labels are static staff-tool strings, not assistant copy. ✅
- **Secrets/.env**: New `STAFF_SESSION_COOKIE_NAME` (+ optional `STAFF_SESSION_TTL_HOURS`); reuse existing `EE_USAGE_ADMIN_TOKEN` for bootstrap only. `.env.example` updated. No secrets committed. ✅
- **Customer data & auditability**: Staff axis is least-privilege, default-deny by role, separate session issuer; every mutation audited; observability section in spec. ✅
- **Module boundaries explicit**: New EE module owns staff-auth domain; transport (routers) ≠ orchestration (services) ≠ persistence (repositories/Kysely). See Module Ownership below. ✅
- **Responsibility-limited files**: `EnterpriseUsageLimitService` stays tier-only; `usageLimitRoutes.ts` is NOT extended with staff concerns — staff + directory live in a NEW module. ✅
- **Refactor-first**: `usageLimitRoutes.ts` already mixes admin-token, account-session, org-creation, and usage concerns; rather than grow it, the org **directory** read goes in a new `OrganizationDirectoryService` and staff routes in a new module. No blocking refactor of existing files required. ✅
- **Application composition**: New infrastructure (staff session issuer, `requireStaffSession`/`requireStaffRole` guards, new migrator, route mount) registers through the **EE module's own** `ApplicationModuleRegistrationContext` (`registerRouteMount`/`registerDatabaseMigrator`), mirroring `usageLimits`. It does NOT touch `backend/src/app/composition/`, and needs **no** OSS-contract change (`auditService` is already on the EE port — Decision A resolved). ✅
- **OpenAPI**: EE endpoints are **not** represented in the OSS code-first OpenAPI registry today (the existing `/ee/usage-limits` routes are absent). This feature **matches that precedent** — staff/console contracts are documented in `ee/` docs, not `backend/src/app/http/openapi/document.ts`. `backend/openapi.yaml`/`.json` remain untouched. (See Open Decision B.)
- **Message-queue impact**: **N/A** — no worker dispatch, AMQP payloads, or retry semantics. The feature is synchronous HTTP + Postgres. No queue docs/tests affected.
- **Docs**: `ee/readme.md` updated (new module, staff bootstrap, env vars); the operator-console package gets a local `readme.md`; `.env.example` updated. Product-surface doc review done in the same change.

## Project Structure

### Documentation (this feature)

```text
specs/098-operator-console/
├── spec.md              # approved
├── plan.md              # this file
├── data-model.md        # entities + table DDL (Phase 1)
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
ee/packages/backend-module/src/
├── staffConsole/                         # NEW backend feature module
│   ├── applicationModule.ts              # registers route mount + migrator + manifest
│   ├── featureManifest.ts                # id: enterprise-operator-console
│   ├── staffConsoleMigrator.ts           # CREATE TABLE ee_staff_users, ee_staff_sessions
│   ├── staffAuthService.ts               # staff session lifecycle (create/verify/revoke)
│   ├── staffCrypto.ts                     # bcryptjs + node:crypto (EE-local; no OSS import)
│   ├── staffRepository.ts                # ee_staff_users CRUD
│   ├── staffSessionRepository.ts         # ee_staff_sessions CRUD
│   ├── staffGuards.ts                    # requireStaffSession, requireStaffRole(role)
│   ├── organizationDirectoryService.ts   # listOrganizations(): accounts+owner+tier+headline usage
│   ├── staffBootstrap.ts                 # owner provision/reset, gated by EE_USAGE_ADMIN_TOKEN
│   ├── staffConsoleRoutes.ts             # /api/v1/ee/operator-console/* router
│   └── *.test.ts                          # TDD: auth, roles, directory, audit, bootstrap
├── db/eeSchema.ts                        # EXTEND: add ee_staff_* tables + read subset of
│                                         #   accounts, account_memberships, users
└── index.ts                              # EXTEND: add staffConsole to featureModules

ee/packages/operator-console/             # NEW EE frontend package (mirrors auth-frontend)
├── package.json                          # name @radioso/enterprise-operator-console, private
├── feature-manifest.mjs                  # frontendRoutes: login + console pages
├── tsconfig.json
├── readme.md
└── src/
    ├── featureManifest.ts
    ├── pages/                            # staff-login, orgs, org-detail, tiers (App Router pages)
    ├── components/                       # directory table, tier form, change-tier, staff-layout
    └── lib/staff-auth-api.ts             # EE-local API client (NOT frontend/lib)

scripts/enterprise-feature-manifests.mjs # EXTEND: register operator-console manifest
.env.example                             # EXTEND: STAFF_SESSION_COOKIE_NAME (+ optional TTL)
```

**Structure Decision**: Web app with an EE backend feature module
(`ee/packages/backend-module/src/staffConsole/`) and a new EE frontend package
(`ee/packages/operator-console/`). The backend module owns staff-auth domain +
the org-directory read; persistence is EE Kysely on the OSS-owned pool. The
frontend package owns all rendering and is route-synced into Next.js exactly
like `auth-frontend`, so OSS builds stub it out. Existing `usageLimits` module is
reused for tier/usage operations and is **not** modified beyond what Decision A
may require.

## Module Ownership & Seams

- **Transport Layer**: `staffConsoleRoutes.ts` (Express router under
  `/api/v1/ee/operator-console`) — parses/validates (Zod), delegates; owns no
  business rules. Frontend pages/components own rendering only.
- **Orchestration Layer**: `staffAuthService.ts` (session lifecycle, login),
  `organizationDirectoryService.ts` (composes `EnterpriseUsageLimitService` for
  tier/usage + its own account/owner queries). Coordinates; delegates domain
  decisions.
- **Domain Layer**: role authorization rules (`staffGuards.ts`), staff identity
  rules, bootstrap policy (`staffBootstrap.ts`), and the existing tier rules in
  `EnterpriseUsageLimitService` (unchanged).
- **Persistence/Integration Layer**: `staffRepository.ts`,
  `staffSessionRepository.ts` (EE Kysely), and read queries against the
  OSS-owned `accounts`/`account_memberships`/`users`/`ee_usage_limit_*` tables
  via the shared pool.
- **Application Composition**: Registers through the **EE module context**
  (`registerRouteMount`, `registerDatabaseMigrator`) — `backend/src/app/composition/`
  is **not** touched. The only possible OSS-side change is exposing
  `auditService` on the EE `RouteDependencies`/`AppDependencies` port (Decision A).
- **Files Kept Small**: `EnterpriseUsageLimitService` stays tier/usage-only;
  `usageLimitRoutes.ts` gains no staff or directory concerns; `eeSchema.ts`
  grows only by table definitions.
- **Planned Extractions**: New `staffConsole` backend module; new
  `OrganizationDirectoryService` (so directory composition doesn't bloat
  `usageLimitService`); EE-local `staffCrypto` (so the boundary isn't crossed to
  reach OSS `authPrimitives`); new EE frontend package.
- **Required Refactor Stories**: None blocking. (`usageLimitRoutes.ts` is
  already multi-concern but is left untouched; new concerns go to the new module.)

## Decisions (all resolved)

- **A — Audit transport for EE. RESOLVED.** `auditService.record({ accountId?,
  workspaceId?, eventType, eventStatus, metadata })` is **already** in the EE
  port (`radiosoModuleTypes.ts:187`). Staff mutations emit `event_type:
  "staff.*"` (e.g. `staff.tier.assigned`, `staff.tier.upserted`,
  `staff.user.created`, `staff.bootstrap`) with actor + before/after in sanitized
  metadata. **No OSS-contract change, no EE audit table.** Pass `accountId` when
  the target is an org so events are queryable by org.
- **B — Staff API contract documentation. RESOLVED (match precedent).** EE
  endpoints stay out of the OSS code-first OpenAPI (as `/ee/usage-limits` already
  is). The console API is documented in `ee/readme.md` / an EE-local contract
  doc; `backend/openapi.yaml`/`.json` are untouched.
- **C — Roles storage shape. RESOLVED (single column).** One `role` column on
  `ee_staff_users`, ranked `support_read` < `billing_write` < `owner`, one role
  per staff user in v1. Revisit only if multi-role is needed.

## Phasing (for /speckit.tasks)

1. **Staff identity + auth foundation** (US1 enabler): `ee_staff_*` tables +
   migrator, `staffCrypto`, repositories, `staffAuthService`, login route,
   `requireStaffSession`/`requireStaffRole`, separate cookie. + bootstrap
   (FR-015) gated by `EE_USAGE_ADMIN_TOKEN`.
2. **Org directory + usage read** (US1): `OrganizationDirectoryService`,
   `GET /accounts` (paginated, owner-from-membership, headline usage),
   per-org detail reusing `getAccountUsage`, tier catalog read.
3. **Mutations + audit** (US2/US3): change tier per org, create/edit tier — all
   via `requireStaffRole('billing_write')`, each emitting an audit event.
4. **Role enforcement + staff management** (US4): owner-only staff CRUD/role
   assignment; per-endpoint 403 tests for every role.
5. **Frontend package** (US1–US4 surfaces): `operator-console` package, manifest
   registration, staff login + directory + detail + tiers screens, Playwright
   journeys.
6. **Docs + .env.example + ee/readme.md**, contract/observability wrap-up.

## Complexity Tracking

No constitution violations requiring justification. The new tables and the new
authority axis are the minimum to retire the shared-god-token shortcut the spec
exists to fix; a single static bearer was the rejected simpler alternative
(no identity, no roles, no audit — explicitly inadequate per the spec).

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Separate staff session issuer + tables | Operator authority must not ride the customer session (blast radius, EE-in-OSS leak) | Reusing customer sessions/roles collapses two authority axes and exposes platform admin via the customer login surface |
