# Tasks: EE Organization Creation Rate Limit

**Input**: Design documents from `/specs/083-ee-org-creation-rate-limit/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before implementation. Integration tests are DB-gated and must not be required for the unit/contract green loop.

**Organization**: Tasks are grouped by user story and preserve the module ownership defined in `plan.md`.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm feature artifacts and working tree context.

- [X] T001 Verify Speckit artifacts exist in specs/083-ee-org-creation-rate-limit/
- [X] T002 Inspect existing usage-limit, auth, composition, OpenAPI, docs, and frontend create-organization files

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the shared guard port and composition seam that every story uses.

- [X] T003 [P] Add failing unit tests for `NoopOrganizationCreationGuard` in backend/tests/unit/organization-creation-guard.test.ts
- [X] T004 [P] Add failing composition/dependency tests for default and registered organization guard wiring in backend/tests/unit/application-composition.test.ts or a focused sibling
- [X] T005 Add `OrganizationCreationGuard` and no-op implementation in backend/src/shared/domain/organizationCreationGuard.ts
- [X] T006 Update backend composition registration types and default composition in backend/src/app/composition/applicationModule.ts and backend/src/app/composition/defaultComposition.ts
- [X] T007 Update server dependency types/builders to inject the resolved organization guard into `AuthService` in backend/src/app/server/types.ts, backend/src/app/server/dependencies.ts, and backend/src/app/server/dependencyBuilders.ts
- [X] T008 Update EE module structural contract with `registerOrganizationCreationGuard` in ee/packages/backend-module/src/radiosoModuleTypes.ts

**Checkpoint**: Auth can depend on a narrow guard port, and OSS default behavior is no-op.

---

## Phase 3: User Story 1 - Cap Runaway Organization Creation (Priority: P1) 🎯 MVP

**Goal**: EE rejects additional organization creation with 429 when the user reaches the monthly cap, without partial provisioning.

**Independent Test**: With an enforcing guard, create up to the limit, then verify the next `POST /account/accounts` returns 429 and no account/workspace/membership/session is created.

### Tests for User Story 1

- [X] T009 [P] [US1] Add failing AuthService unit tests for reserve-before-create, commit-on-success, release-on-failure, and rate-limit audit behavior in backend/tests/unit/auth-service.test.ts
- [X] T010 [P] [US1] Add failing contract test for `POST /account/accounts` 429 envelope in backend/tests/contract/auth.contract.test.ts
- [X] T011 [P] [US1] Add failing EE guard unit tests for limit resolution, atomic boundary SQL shape, and release decrement in ee/packages/backend-module/src/orgCreation/organizationCreationGuard.test.ts
- [X] T012 [P] [US1] Add DB-gated integration tests for migrator tables and concurrent reservation boundary in backend/tests/integration/org-creation-guard.integration.test.ts

### Implementation for User Story 1

- [X] T013 [US1] Hook `AuthService.createOrganization` to reserve, commit, release, and audit rate-limited failures in backend/src/modules/auth/services/authService.ts
- [X] T014 [US1] Implement EE organization creation guard and helpers in ee/packages/backend-module/src/orgCreation/organizationCreationGuard.ts
- [X] T015 [US1] Add EE migrator tables and constraints in ee/packages/backend-module/src/usageLimits/usageLimitMigrator.ts
- [X] T016 [US1] Register EE enforcing guard in ee/packages/backend-module/src/usageLimits/applicationModule.ts
- [X] T017 [US1] Update OpenAPI schemas/path for create-organization 429 in backend/src/app/http/openapi/openApiRegistry.ts and backend/src/app/http/openapi/paths/accountPaths.ts
- [X] T018 [US1] Regenerate backend/openapi.yaml and backend/openapi.json with backend `pnpm run generate:openapi`

**Checkpoint**: US1 is independently testable with unit and contract tests; DB concurrency coverage exists and skips without a database.

---

## Phase 4: User Story 2 - Legitimate Users Still Create Organizations Freely (Priority: P1)

**Goal**: Below-cap creations preserve the existing response and signup remains uncapped.

**Independent Test**: Verify `AuthService.register` does not call the guard and below-limit `createOrganization` succeeds with the existing response shape.

### Tests for User Story 2

- [X] T019 [P] [US2] Add failing AuthService unit test proving signup does not reserve through the organization guard in backend/tests/unit/auth-service.test.ts
- [X] T020 [P] [US2] Add frontend unit test for surfacing API error messages in frontend/tests/unit/account-api.test.ts or a focused component test if existing patterns support it

### Implementation for User Story 2

- [X] T021 [US2] Confirm `AuthService.register` remains unmetered while createOrganization uses the guard in backend/src/modules/auth/services/authService.ts
- [X] T022 [US2] Surface backend create-organization error messages in frontend/components/dashboard/workspace-switcher.tsx and type details in frontend/lib/api-client.ts if needed

**Checkpoint**: Signup is never blocked, below-cap org creation is unchanged, and the create-org UI shows the backend limit message.

---

## Phase 5: User Story 3 - Operator Override Per User (Priority: P2)

**Goal**: Operators can read, set, remove, and set unlimited per-user organization creation overrides with the existing admin token.

**Independent Test**: Set an integer override and an unlimited override, verify effective limits change for that user only, then delete the override and return to default behavior.

### Tests for User Story 3

- [X] T023 [P] [US3] Add failing EE guard unit tests for override read/upsert/delete and unlimited override behavior in ee/packages/backend-module/src/orgCreation/organizationCreationGuard.test.ts
- [X] T024 [P] [US3] Add failing EE admin route tests for GET/PUT/DELETE override and token guard in ee/packages/backend-module/src/usageLimits/usageLimitRoutes.test.ts
- [X] T025 [P] [US3] Add failing OpenAPI contract assertions for EE override routes in backend/tests/contract/openapi.contract.test.ts

### Implementation for User Story 3

- [X] T026 [US3] Add override service methods in ee/packages/backend-module/src/orgCreation/organizationCreationGuard.ts
- [X] T027 [US3] Mount GET/PUT/DELETE `/org-creation/users/:userId` under usage-limit routes in ee/packages/backend-module/src/usageLimits/usageLimitRoutes.ts
- [X] T028 [US3] Add OpenAPI schemas and routes for EE override endpoints in backend/src/app/http/openapi/openApiRegistry.ts and a route path module
- [X] T029 [US3] Regenerate backend/openapi.yaml and backend/openapi.json with backend `pnpm run generate:openapi`

**Checkpoint**: Operator override API is authenticated and documented in generated OpenAPI.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, environment examples, validation, and final reporting.

- [X] T030 Add `EE_MAX_ORGS_PER_USER_PER_MONTH` to .env.example
- [X] T031 Update EE operator docs in ee/readme.md and docs-portal/content/operators/enterprise-usage-limits.mdx after reading docs/document-writer-prompt.md
- [X] T032 Run backend `pnpm run build`, `pnpm run test:unit`, and `pnpm run test:contract` from backend/
- [X] T033 If frontend was touched, run frontend `pnpm run build`, `pnpm run lint`, and relevant tests from frontend/
- [X] T034 Update task checkboxes in specs/083-ee-org-creation-rate-limit/tasks.md
- [X] T035 Write completion report in .context/codex-result.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Blocks all user stories.
- **US1 (Phase 3)**: Depends on foundational guard seam.
- **US2 (Phase 4)**: Depends on foundational seam and shares auth/frontend files with US1, so execute after US1 locally.
- **US3 (Phase 5)**: Depends on EE guard implementation from US1.
- **Polish (Phase 6)**: Depends on all stories.

### Parallel Opportunities

- T003, T004 can be authored independently.
- T009, T010, T011, T012 can be authored independently before implementation.
- T023, T024, T025 can be authored independently before implementation.
- Docs and `.env.example` can be updated after implementation behavior stabilizes.

## Implementation Strategy

1. Establish the guard seam and OSS no-op default.
2. Deliver US1 as the MVP: auth reservation lifecycle, EE enforcing guard, migrator, 429 contract.
3. Confirm US2 behavior: signup unmetered, below-cap behavior unchanged, UI error message surfaced.
4. Add US3 operator override API.
5. Regenerate OpenAPI, update docs, run validation, and write the completion report.
