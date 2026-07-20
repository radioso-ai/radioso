# Tasks: Enterprise Multi-Organization Creation

**Input**: Design documents from `/specs/101-ee-additional-organizations/`
**Prerequisites**: Approved spec, plan, research, data model, contract notes, quickstart

**Tests**: Backend tests are required and must fail before implementation. User-visible frontend behavior uses Playwright; unit tests cover API and edition logic only.

## Phase 1: Setup and Baseline

**Purpose**: Confirm the approved scope and existing behavior before changing production code.

- [X] T001 Record approval, constitution checks, module ownership, and queue-impact decision in `specs/101-ee-additional-organizations/spec.md` and `specs/101-ee-additional-organizations/plan.md`
- [X] T002 [P] Capture focused baseline results for auth, organization-guard, composition, EE organization-limit, frontend API, and edition-controller suites in `specs/101-ee-additional-organizations/quickstart.md`

---

## Phase 2: Foundational Policy Contract and Composition Seam

**Purpose**: Establish the intent-aware reservation contract and OSS/EE selection boundary used by every story.

- [X] T003 Write failing contract tests for signup/additional intents, availability, and advisory-lock reservation lifecycle in `backend/tests/unit/organization-creation-guard.test.ts`
- [X] T004 Extend the narrow organization policy types and inert implementation in `backend/src/shared/domain/organizationCreationGuard.ts` and mirror the host contract in `ee/packages/backend-module/src/radiosoModuleTypes.ts`
- [X] T005 Write failing composition tests for the built-in OSS auth module and EE override in `backend/tests/unit/default-composition.test.ts` and `ee/packages/backend-module/src/index.test.ts`
- [X] T006 Add the auth-owned PostgreSQL advisory-lock adapter, policy/composition files, and wire the module in `backend/src/app/composition/defaultComposition.ts` without a schema change
- [X] T007 Update `backend/src/app/composition/README.md` and `docs/architecture/code-map.md` only if the new auth composition entry point would otherwise be undiscoverable

**Checkpoint**: Default OSS and optional EE composition select different implementations through one policy port.

---

## Phase 3: User Story 1 - Bootstrap One OSS Organization (Priority: P1) MVP

**Goal**: One empty OSS deployment can provision exactly one organization safely.

**Independent Test**: Run two real-Postgres signup reservations concurrently, complete one bootstrap, and verify one organization plus clean rollback/retry behavior.

### Tests for User Story 1

- [X] T008 [US1] Write failing real-Postgres tests for advisory-lock concurrency, in-flight availability, same-client commit/release, and reopening after organization deletion in `backend/tests/integration/oss-organization-creation-guard.integration.test.ts`
- [X] T009 [US1] Write failing auth-service tests for password and federated signup reservation commit/release, including account-create failure, in `backend/tests/unit/auth-service.test.ts`
- [X] T010 [US1] Write failing service and real-PostgreSQL tests for concurrent first-signup exclusion and provisioning-failure retry in `backend/tests/unit/auth-service.test.ts` and `backend/tests/integration/oss-organization-creation-guard.integration.test.ts`

### Implementation for User Story 1

- [X] T011 [US1] Implement the dedicated-client PostgreSQL advisory-lock adapter and OSS policy in the files introduced by T006
- [X] T012 [US1] Apply signup reservation lifecycle to password registration and new federated-account provisioning in `backend/src/modules/auth/services/authService.ts`
- [X] T013 [US1] Run the US1 unit/integration tests and record green validation in `specs/101-ee-additional-organizations/quickstart.md`

---

## Phase 4: User Story 2 - Join OSS by Invitation (Priority: P2)

**Goal**: Initialized OSS rejects open signup while invitations still add users to the existing organization.

**Independent Test**: Bootstrap OSS, observe a second direct signup denial with no artifacts, then accept an invitation into the existing organization.

### Tests for User Story 2

- [X] T014 [US2] Write failing auth-service and contract tests for stable sanitized initialized-OSS signup denial in `backend/tests/unit/auth-service.test.ts` and `backend/tests/contract/auth.contract.test.ts`
- [X] T015 [US2] Add/adjust invitation preservation integration coverage in `backend/tests/integration/auth.integration.test.ts`

### Implementation for User Story 2

- [X] T016 [US2] Record sanitized fixed-reason denial audits and preserve invitation provisioning outside the organization policy in `backend/src/modules/auth/services/authService.ts`
- [X] T017 [US2] Run registration/invitation contract and integration tests and record green validation in `specs/101-ee-additional-organizations/quickstart.md`

---

## Phase 5: User Story 3 - Create Multiple Organizations in Enterprise (Priority: P3)

**Goal**: Enterprise signup remains open and signed-in additional creation retains its monthly limit and safe reservation lifecycle.

**Independent Test**: Use the Enterprise guard for signup and additional intents, verify signup is inert, additional creation increments/commits, capped requests remain `429`, and every failure releases.

### Tests for User Story 3

- [X] T018 [US3] Write failing EE unit/integration tests for intent handling and unchanged overrides/counters in `ee/packages/backend-module/src/orgCreation/organizationCreationGuard.test.ts` and `ee/packages/backend-module/src/orgCreation/organizationCreationGuard.integration.test.ts`
- [X] T019 [US3] Write failing auth-service regression for reservation release when account creation itself fails in `backend/tests/unit/auth-service.test.ts`

### Implementation for User Story 3

- [X] T020 [US3] Update `ee/packages/backend-module/src/orgCreation/organizationCreationGuard.ts` to allow signup without charging and retain additional-creation limits
- [X] T021 [US3] Move account persistence inside the protected reservation lifecycle and keep safe limit-denial audit details in `backend/src/modules/auth/services/authService.ts`
- [X] T022 [US3] Run EE organization guard, backend auth, and EE build tests and record green validation in `specs/101-ee-additional-organizations/quickstart.md`

---

## Phase 6: User Story 4 - Create Workspaces in Either Edition (Priority: P4)

**Goal**: Workspace creation stays edition-independent and permission behavior remains unchanged.

**Independent Test**: Create a second workspace in the OSS organization and in an Enterprise organization without organization-policy reservations.

### Tests and Verification for User Story 4

- [X] T023 [US4] Add a guard-spy regression proving workspace creation never consults organization policy in `backend/tests/integration/auth.integration.test.ts` or the closest existing workspace integration suite
- [X] T024 [US4] Run existing authorized/unauthorized workspace-create integration coverage and confirm no changes are needed in `backend/src/modules/workspace/`

---

## Phase 7: User Story 5 - Present the Correct Edition Experience (Priority: P5)

**Goal**: Auth and dashboard controls reflect server initialization and edition without weakening server authority.

**Independent Test**: Mock empty/initialized availability in the auth UI and verify OSS dashboard shows new workspace but not new organization; verify Enterprise capability remains enabled.

### Tests for User Story 5

- [X] T025 [US5] Write failing contract tests for `GET /api/v1/auth/registration`, OSS `403` responses, and documented additional-organization responses in `backend/tests/contract/auth.contract.test.ts` and `backend/tests/contract/openapi.contract.test.ts`
- [X] T026 [P] [US5] Write failing frontend API and edition capability tests in `frontend/tests/unit/auth-api.test.ts` and `frontend/tests/unit/edition-controller.test.ts`
- [X] T027 [P] [US5] Write failing Playwright journeys for registration availability and OSS switcher workspace/organization actions in `frontend/tests/e2e/organization-availability.spec.ts`

### Implementation for User Story 5

- [X] T028 [US5] Add the no-store registration availability route in `backend/src/app/http/routes/authRoutes.ts` backed by `AuthService`/policy state
- [X] T029 [US5] Add the registration response schema and auth/account path contracts in `backend/src/app/http/openapi/schemas/identitySchemas.ts`, `backend/src/app/http/openapi/openApiRegistry.ts`, `backend/src/app/http/openapi/paths/authPaths.ts`, and `backend/src/app/http/openapi/paths/accountPaths.ts`
- [X] T030 [US5] Add the typed availability API adapter in `frontend/lib/api-types.ts` and `frontend/lib/api-auth.ts`
- [X] T031 [US5] Make `frontend/components/auth/auth-page.tsx` and `frontend/components/auth/login-form.tsx` availability-aware with invitation guidance and no registration flash
- [X] T032 [US5] Add `canCreateAdditionalOrganizations()` in `frontend/lib/edition-controller.ts` and gate only the additional-organization menu/dialog in `frontend/components/dashboard/workspace-switcher.tsx`
- [X] T033 [US5] Run focused backend contract, frontend unit, and Playwright tests and record green validation in `specs/101-ee-additional-organizations/quickstart.md`

---

## Phase 8: Contracts, Documentation, and Cross-Cutting Validation

**Purpose**: Synchronize generated artifacts, public guidance, review evidence, and release readiness.

- [X] T034 Regenerate code-first OpenAPI and downstream generated types via `backend` generation and `typescript-sdk` sync; verify `backend/openapi.yaml`, `backend/openapi.json`, SDK specs/types, and MCP generated types are in sync
- [X] T035 [P] Update OSS setup and REST guidance in `readme.md`, `docs-portal/content/quickstarts/run-locally.mdx`, and `docs-portal/content/quickstarts/api-first-success.mdx`, correcting the existing registration-session wording
- [X] T036 [P] Update auth/account/API guidance in `docs-portal/content/api/auth-and-sessions.mdx`, `docs-portal/content/api/accounts-and-users.mdx`, and `docs-portal/content/guides/authentication.mdx`
- [X] T037 [P] Update Enterprise organization-cap guidance in `docs-portal/content/operators/enterprise-usage-limits.mdx` and `ee/readme.md`
- [X] T038 Confirm and record that document dispatch, AMQP payloads/retries, queue tests/docs, SDK workflow contracts, MCP behavior, and connector contracts are unaffected in `specs/101-ee-additional-organizations/plan.md`
- [X] T039 Run focused backend unit/integration/contract/build, frontend test/lint/build/Playwright, EE test/build, API contract sync, and architecture validation from `specs/101-ee-additional-organizations/quickstart.md`
- [X] T040 Run `pnpm run ci:local -- origin/main` and record the result for the PR body
- [X] T041 Perform up to three senior-engineer review passes, apply blocking findings, and rerun affected tests
- [X] T042 Perform one engineering-manager scope/release review and apply all in-scope feedback
- [X] T043 Commit with a Conventional Commit message, push `move-multi-org-to-ee`, and open a draft-ready GitHub PR targeting `main` with spec/plan/tasks links and validation evidence

## Phase 9: Senior Review Remediation

**Purpose**: Close the approved table-free crash-consistency and auth-startup recovery findings before final review.

- [X] T044 Update the approved spec, plan, research, data model, contract notes, and tasks with the transactional core-provisioning decision and post-transaction recovery semantics
- [X] T045 Write failing unit and real-PostgreSQL interruption tests for a narrow organization provisioner that atomically creates account, new user when applicable, owner membership, and default workspace without schema changes
- [X] T046 Implement the transaction-scoped organization provisioner/unit-of-work adapter and wire it into `AuthService` composition without duplicating membership or workspace domain rules
- [X] T047 Preserve hook, session, audit, reservation, and account-delete compensation behavior after the core transaction; add focused failure-lifecycle tests
- [X] T048 Add a failing frontend retry/recovery test, then implement bounded registration-availability retry plus an explicit retry affordance without registration flash
- [X] T049 Add direct HTTP OSS additional-organization zero-mutation coverage and strengthen concurrent bootstrap orchestration coverage where feasible
- [X] T050 Rerun focused and full validation, then repeat the independent senior review before the single engineering-manager review

## Dependencies & Execution Order

- Phase 1 precedes planning-dependent work.
- Phase 2 is foundational and blocks every story.
- US1 establishes OSS bootstrap semantics; US2 builds invitation-only onboarding on top of it.
- US3 shares the intent-aware contract but remains independently testable through the EE module.
- US4 is a regression boundary and can be verified after the shared policy is wired.
- US5 depends on policy-owned availability and edition semantics from US1/US3.
- Contract generation and docs follow implementation; review and PR creation follow all validation.

## Parallel Opportunities

- Backend policy work and frontend test scaffolding touch disjoint files after the contract shape is fixed.
- Frontend API/capability unit tests and Playwright tests are disjoint.
- Setup/auth/account/Enterprise documentation files can be updated in parallel after runtime behavior stabilizes.
- Review roles are independent of implementation and run only after initial validation.

## Implementation Strategy

Deliver the server-authoritative OSS bootstrap policy first, prove concurrency and rollback, preserve invitations and workspace creation, then adapt Enterprise intent handling. Add the public availability projection and UI only after server semantics are green. Finish with generated contracts, docs, independent reviews, local CI, and a PR on the existing branch.
