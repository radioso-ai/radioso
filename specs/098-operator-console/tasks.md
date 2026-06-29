# Tasks: Operator Console — Customer & Usage-Tier Administration

**Input**: Design documents from `/specs/098-operator-console/`
**Prerequisites**: plan.md, spec.md, data-model.md (all present)

**Tests**: Backend TDD is REQUIRED — Vitest/Supertest tests written and failing before implementation. Frontend user-visible flows use Playwright; frontend Vitest only for non-visual logic (byte-unit formatting, API adapters).

**Architecture (from plan.md, MUST hold)**:
- All new code lives in `ee/`. OSS build stays free of any reference (boundary validator must pass).
- `EnterpriseUsageLimitService` stays tier/usage-only; `usageLimitRoutes.ts` gains no staff/directory concerns.
- Staff identities are **platform-global** (no workspace/account FK).
- EE **must not import** OSS `authPrimitives`; staff crypto is EE-local (`bcryptjs` + `node:crypto`).
- Audit via the already-injected `auditService` (EE port `radiosoModuleTypes.ts:187`); no EE audit table, no OSS-contract change.
- EE endpoints stay out of OSS OpenAPI.

**Conventions**: `[P]` = parallelizable (different files, no dep). `[USn]` = user story. Backend module path: `ee/packages/backend-module/src/staffConsole/`. Frontend package: `ee/packages/operator-console/`.

---

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 Create the `staffConsole` backend module skeleton dir `ee/packages/backend-module/src/staffConsole/` with `featureManifest.ts` (`id: enterprise-operator-console`, `apiNamespaces: ["/api/v1/ee/operator-console"]`) and an empty `applicationModule.ts` exporting a feature module shaped like `usageLimits/applicationModule.ts`.
- [ ] T002 Wire the new module into the aggregate `ee/packages/backend-module/src/index.ts` `featureModules` list (registration only; no routes yet).
- [ ] T003 [P] Add env vars `STAFF_SESSION_COOKIE_NAME` (required) and `STAFF_SESSION_TTL_HOURS` (optional) to `.env.example` and to the EE env typing/validation path used by the module; document defaults.

---

## Phase 2: Foundational — Staff identity, sessions, auth, roles, bootstrap (BLOCKS US1–US4)

**⚠️ No user story work begins until this phase is complete.** This is the staff authority axis.

### Tests first (REQUIRED, must FAIL before impl)

- [ ] T004 [P] Migrator test: `staffConsoleMigrator` creates `ee_staff_users` + `ee_staff_sessions` with the indexes/uniques in data-model.md (run against a clean test DB).
- [ ] T005 [P] `staffCrypto` unit tests: bcrypt hash/verify round-trip, token generation, sha256 token hashing — asserting NO import from `backend/src` (boundary).
- [ ] T006 [P] `staffAuthService` tests: create session on valid login, reject wrong password, reject disabled user, `authenticateStaffSession` rejects expired/revoked/unknown, revoke works.
- [ ] T007 [P] Guard tests: `requireStaffSession` rejects missing/customer cookie with 401; `requireStaffRole('billing_write')` rejects `support_read` with 403, allows `billing_write`/`owner` (default-deny).
- [ ] T008 [P] Bootstrap tests: with valid `EE_USAGE_ADMIN_TOKEN`, provision first `owner` (audited actor `staff.bootstrap`) and reset a locked-out owner credential; invalid/absent token creates nothing; bootstrap path cannot perform any other console action.

### Implementation

- [ ] T009 Extend `ee/packages/backend-module/src/db/eeSchema.ts`: add `ee_staff_users` + `ee_staff_sessions` table interfaces, and add read-only subsets of `accounts`, `account_memberships`, `users` to `EeDatabase`.
- [ ] T010 Create `staffConsole/staffConsoleMigrator.ts` (CREATE TABLE IF NOT EXISTS for both tables + indexes per data-model.md); register via `context.registerDatabaseMigrator` in `applicationModule.ts`.
- [ ] T011 [P] Create `staffConsole/staffCrypto.ts` (EE-local `bcryptjs` hash/verify, `node:crypto` token gen + sha256). No OSS import.
- [ ] T012 [P] Create `staffConsole/staffRepository.ts` (`ee_staff_users` CRUD: findByEmail, findById, create, updatePassword, setRole, setStatus, touchLastLogin).
- [ ] T013 [P] Create `staffConsole/staffSessionRepository.ts` (`ee_staff_sessions` create/findActiveByTokenHash/touch/revoke).
- [ ] T014 Create `staffConsole/staffAuthService.ts` (login → verify → mint session; `authenticateStaffSession`; revoke). Depends on T011–T013.
- [ ] T015 Create `staffConsole/staffGuards.ts` (`requireStaffSession` reading `STAFF_SESSION_COOKIE_NAME` + `requireStaffRole(minRole)` using the rank order). Sets `res.locals.staff = { id, role }`.
- [ ] T016 Create `staffConsole/staffBootstrap.ts` + bootstrap route gated by `requireAdminToken` (reuse the `EE_USAGE_ADMIN_TOKEN` pattern from `usageLimitRoutes.ts`): provision/reset `owner`, emit `staff.bootstrap` audit. Capable of nothing else.
- [ ] T017 Create `staffConsole/staffConsoleRoutes.ts` with the login route (`POST /api/v1/ee/operator-console/auth/login` → sets staff cookie), logout, `GET /auth/me`, and the bootstrap route; mount via `context.registerRouteMount({ path: "/api/v1/ee/operator-console", createRouter })` in `applicationModule.ts`.

**Checkpoint**: A staff owner can be bootstrapped and sign in; role guards enforce default-deny. Foundation ready.

---

## Phase 3: User Story 1 — Directory, tiers, per-org usage (read-only) (P1) 🎯 MVP

**Goal**: Signed-in operator sees all orgs (+ current tier + headline usage), per-org full usage, and the tier catalog.
**Independent Test**: Seed staff + orgs on different tiers; assert directory rows (name, membership-derived owner email, tier, monthly answers used/limit), org-detail 4-resource breakdown, and tier list. Unauthed/customer-session requests rejected.

### Tests first (REQUIRED, must FAIL)

- [ ] T018 [P] [US1] `OrganizationDirectoryService.listOrganizations` test: pagination + search; owner email derived from `account_memberships(role='owner', active)`→`users.email` (primary = earliest), "no owner" when none, NEVER `accounts.email`; headline usage = monthly answers used/limit only.
- [ ] T019 [P] [US1] Route tests (Supertest, staff session): `GET /organizations` (list shape, auth required), `GET /organizations/:accountId/usage` (full breakdown reusing `getAccountUsage`), `GET /tiers` (profiles). 401 without staff session.

### Implementation

- [ ] T020 [US1] Create `staffConsole/organizationDirectoryService.ts` — composes `EnterpriseUsageLimitService` (tier/usage) with its own `accounts`+`account_memberships`+`users` queries; cheap per-row usage. Depends on Phase 2.
- [ ] T021 [US1] Add read routes to `staffConsoleRoutes.ts` under `requireStaffSession` (all roles): `GET /organizations`, `GET /organizations/:accountId/usage`, `GET /tiers`.
- [ ] T022 [US1] Add structured logs (Pino) for staff read-path auth outcomes per the spec Observability section (no secrets/PII; emails out of metric labels).

**Checkpoint**: US1 fully functional and testable independently (read-only console).

---

## Phase 4: User Story 2 — Change an org's tier (P1)

**Goal**: `billing_write`/`owner` assigns/unassigns a tier per org; effective immediately; audited.
**Independent Test**: Change org A `starter`→`growth`; assignment + subsequent usage limits reflect it; `staff.tier.assigned` audit captured (actor, org, from→to). Unassign clears. `support_read` gets 403.

### Tests first (REQUIRED, must FAIL)

- [ ] T023 [P] [US2] Route test: `PUT /organizations/:accountId/tier` with `{profileKey}` under `requireStaffRole('billing_write')`; success path updates assignment (delegates to `assignProfile`), `profileKey:null` unassigns, `support_read` → 403.
- [ ] T024 [P] [US2] Audit test: a successful tier change emits `auditService.record` with `event_type: "staff.tier.assigned"`, `accountId` = org, sanitized metadata `{ actorStaffId, fromProfileKey, toProfileKey }`.

### Implementation

- [ ] T025 [US2] Implement `PUT /organizations/:accountId/tier` in `staffConsoleRoutes.ts`: read current assignment (for from→to), call existing `assignProfile`, emit audit. No new tier logic (reuse service).

**Checkpoint**: US1 + US2 work; tier changes are audited and role-gated.

---

## Phase 5: User Story 3 — Create / edit usage tiers (P2)

**Goal**: `billing_write`/`owner` creates/edits tiers (display name + 4 nullable limits; byte limits entered human, stored bytes); audited.
**Independent Test**: Create `growth` with limits → assignable; edit limits → applies to assigned orgs; `staff.tier.upserted` audit. `support_read` 403.

### Tests first (REQUIRED, must FAIL)

- [ ] T026 [P] [US3] Route test: `PUT /tiers/:profileKey` under `requireStaffRole('billing_write')`; create + edit via existing `upsertProfile`; validates key/limits (reuse the existing Zod shapes); `support_read` 403.
- [ ] T027 [P] [US3] Audit test: tier create/edit emits `event_type: "staff.tier.upserted"` with changed fields in sanitized metadata.

### Implementation

- [ ] T028 [US3] Implement `PUT /tiers/:profileKey` in `staffConsoleRoutes.ts` (delegate to `upsertProfile`), emit audit. Byte-limit normalization is a frontend concern; backend stores bytes.

**Checkpoint**: US1–US3 functional; tier catalog manageable + audited.

---

## Phase 6: User Story 4 — Role enforcement + staff management (P2)

**Goal**: Per-endpoint role gating verified; `owner` manages staff identities/roles; non-owner cannot.
**Independent Test**: Per role × endpoint matrix → allowed succeed, disallowed 403 at API. Owner creates a staff user + assigns role; new user signs in with exactly that authority; non-owner blocked.

### Tests first (REQUIRED, must FAIL)

- [ ] T029 [P] [US4] Authorization matrix test: every mutating endpoint rejects `support_read` (403) and accepts `billing_write`/`owner`; every staff-management endpoint accepts only `owner`.
- [ ] T030 [P] [US4] Staff-management route tests: `owner` lists/creates staff and sets role/status (audited `staff.user.*`); non-owner → 403; cannot disable self / cannot demote last owner (edge guard).

### Implementation

- [ ] T031 [US4] Implement owner-only staff routes in `staffConsoleRoutes.ts` under `requireStaffRole('owner')`: `GET /staff`, `POST /staff` (create + temp credential), `PUT /staff/:id/role`, `PUT /staff/:id/status`; emit `staff.user.created` / `staff.user.role_changed` / `staff.user.status_changed` audits; last-owner/self-lockout guard.

**Checkpoint**: All backend user stories independently functional + role-enforced + audited.

---

## Phase 7: Frontend — operator-console EE package (US1–US4 surfaces)

**Goal**: The console UI. Playwright covers the operator journeys.

- [ ] T032 Create EE frontend package `ee/packages/operator-console/` (mirror `auth-frontend`): `package.json` (`@radioso/enterprise-operator-console`, private), `tsconfig.json`, `feature-manifest.mjs` (declare frontendRoutes: staff login + console pages under `app/operator/...`), `src/featureManifest.ts`, `readme.md`.
- [ ] T033 Register the package in `scripts/enterprise-feature-manifests.mjs` (manifest path + package-exports validation entry); verify `scripts/sync-ee-frontend-routes.mjs enable` generates the Next.js re-export routes and `disable` stubs them (OSS build clean).
- [ ] T034 [P] Create `src/lib/staff-auth-api.ts` (EE-local API client → `/api/v1/ee/operator-console/*`, staff cookie) and byte-unit format/parse helpers (the only frontend Vitest unit targets).
- [ ] T035 [P] Build staff login page + `staff-layout` (dark theme, `@radioso/ui` primitives) — separate from customer auth.
- [ ] T036 [P] Build Orgs directory page (table: org, owner email, tier, monthly answers used/limit; search; row → detail).
- [ ] T037 [P] Build Org detail page (4-resource breakdown; change-tier control with current→target confirm; warn-only over-limit notice on lowering).
- [ ] T038 [P] Build Tiers page (list + create/edit form; byte limits in MB/GB → normalized display per FR-010).
- [ ] T039 [US4] Surface role in UI: hide mutate controls for `support_read` (server still enforces); owner-only staff-management screen.
- [ ] T040 Playwright journeys: login; directory + detail (US1); change tier (US2); create/edit tier (US3); role gating + owner staff-create (US4). Vitest unit for byte formatting + API adapter only.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T041 Add metrics counters per spec Observability (staff auth failures, role-denied, tier changes, catalog edits, bootstrap) — low-cardinality labels only (action/role/outcome), never org/staff id/email.
- [ ] T042 Docs: update `ee/readme.md` (new module, staff bootstrap flow, env vars, console API contract) and the operator-console package `readme.md`; confirm `.env.example` complete.
- [ ] T044 Remove the temporary `NODE_ENV==="test"` `/_test/billing-write` probe route in `staffConsoleRoutes.ts` once Phase 4 `billing_write` endpoints exercise `requireStaffRole` naturally.
- [ ] T045 Rate-limit `POST /operator-console/auth/login` (staff login is a high-value brute-force target; OSS customer auth has `AUTH_RATE_LIMIT_*` — apply equivalent to the staff issuer).
- [ ] T043 Run `node scripts/validate-architecture-boundaries.mjs` (OSS has zero refs to console/staff — SC-005), backend `pnpm test` (TDD suites green), frontend lint + Playwright, and `pnpm run ci:local -- origin/main`; record result for the PR body.

---

## Dependencies & Execution Order

- **Phase 1 (Setup)** → **Phase 2 (Foundational, BLOCKING)** → user stories.
- **US1 (P3)** is the MVP and unblocks the others by establishing the directory/read surface.
- **US2/US3/US4 (P4–P6)** depend on Phase 2; US2/US3 reuse the existing usage-limit service; US4 formalizes role gating across all of them.
- **Frontend (Phase 7)** depends on the backend endpoints of the stories it renders (can start US1 screens once Phase 3 is green).
- **Polish (Phase 8)** last.

### Within each story
- Backend tests written and FAILING before implementation (TDD).
- New concerns go in new files in `staffConsole/`; do not extend `usageLimitRoutes.ts` or `EnterpriseUsageLimitService`.
- Models/migrator → repositories → services → routes.
- No `backend/src/app/composition/` changes (module self-registers); no OSS OpenAPI changes; no message-queue impact.

## Codex delegation note

Build order for delegated agents: **Phase 1+2 first as one unit** (the auth foundation — verify by bootstrap+login+guard tests green), then Phases 3→4→5→6 sequentially (each its own verification gate), then Phase 7 frontend, then Phase 8. Pre-build EE package before any `tsc --noEmit`/vitest verification; do NOT let Codex run `pnpm run build` in-sandbox (dist EPERM hang). Orchestrator (Claude) independently verifies each phase — never trust self-reports.
