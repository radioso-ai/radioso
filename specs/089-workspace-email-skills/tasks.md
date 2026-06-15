# Tasks: Workspace Email Connections and Skills

**Input**: Design documents from `/specs/089-workspace-email-skills/`  
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/endpoints.md](./contracts/endpoints.md)

**Tests**: Backend TDD is required. Write failing backend tests before implementation. Use Playwright for visible frontend flows and frontend unit tests only for non-visual adapters/transforms.

**Organization**: Tasks are grouped by user story. Foundational tasks block all user stories because they establish the OAuth reuse boundary.

## Phase 1: Setup

**Purpose**: Confirm current substrate and create focused module/test structure.

- [x] T001 Record the local MCP OAuth merge base and extraction decision in `.context/workspace-email-skills.md`
- [x] T002 [P] Create customer email module placeholder and public surface in `backend/src/modules/customerEmail/public.ts`
- [x] T003 [P] Create reusable OAuth module placeholder or adapter public surface in `backend/src/modules/integrationOauth/public.ts`
- [x] T004 [P] Create customer email backend test directories in `backend/tests/unit/customerEmail/` and `backend/tests/integration/customerEmail/`
- [x] T005 [P] Create frontend API adapter placeholder in `frontend/lib/api-customer-email.ts`

---

## Phase 2: Foundational - Reusable OAuth Boundary

**Purpose**: Shared OAuth lifecycle that customer email consumes and MCP can also consume. No email user story work starts until this is done.

- [x] T006 [P] Add failing unit tests for provider-neutral OAuth URL/exchange/refresh behavior in `backend/tests/unit/integrationOauth/oauthClient.test.ts`
- [x] T007 [P] Add failing unit tests for refresh-before-use and needs-reauth transitions in `backend/tests/unit/integrationOauth/oauthAccessTokenResolver.test.ts`
- [x] T008 Extract reusable OAuth domain types and status transitions from `backend/src/modules/externalSkills/domain.ts` into `backend/src/modules/integrationOauth/domain.ts`
- [x] T009 Extract reusable OAuth client/refresh service from `backend/src/modules/externalSkills/oauth/oauthClient.ts` and `backend/src/modules/externalSkills/oauth/oauthAccessTokenResolver.ts` into `backend/src/modules/integrationOauth/services/`
- [x] T010 Add OAuth repository port and Postgres repository in `backend/src/db/repositories/oauthConnectionRepository.ts`
- [x] T011 Add OAuth connection migration in `backend/src/db/migrations/095_integration_oauth_connections.sql`
- [x] T012 Adapt MCP OAuth code to consume the shared OAuth port in `backend/src/modules/externalSkills/composition.ts` and `backend/src/modules/externalSkills/services/mcpConnectionService.ts`
- [x] T013 Add OpenAPI contract tests for OAuth start/status/reauthorize/callback routes in `backend/tests/contract/customer-email-oauth.contract.test.ts`
- [x] T014 Add thin OAuth routes in `backend/src/app/http/routes/oauthConnectionRoutes.ts`
- [x] T015 Register OAuth routes and schemas in `backend/src/app/http/openapi/paths/oauthConnectionPaths.ts`
- [x] T016 Wire OAuth service/repository/provider registry in `backend/src/app/composition/defaultComposition.ts`
- [x] T017 Add composition tests for OAuth provider registry wiring in `backend/tests/unit/default-composition.test.ts`
- [x] T018 Update `.env.example` with required OAuth provider and encryption configuration

**Checkpoint**: OAuth lifecycle is reusable without email-specific logic.

---

## Phase 3: User Story 1 - Authorize a reusable workspace OAuth connection (Priority: P1) MVP

**Goal**: Operators can authorize an OAuth mail provider and the reusable substrate stores/refreshes credentials safely.

**Independent Test**: Mock OAuth provider authorization, callback, encrypted token storage, refresh-before-use, and refresh-failure-to-reauth pass without email delivery code.

### Tests for User Story 1

- [x] T019 [P] [US1] Add failing service tests for mail-provider required scopes in `backend/tests/unit/customerEmail/oauth-mail-scopes.test.ts`
- [x] T020 [P] [US1] Add failing route tests for mail OAuth authorization start/status in `backend/tests/integration/customerEmail/oauth-mail-routes.test.ts`
- [ ] T021 [P] [US1] Add Playwright test for workspace OAuth authorization status UI in `frontend/tests/e2e/customer-email-oauth.spec.ts`

### Implementation for User Story 1

- [x] T022 [US1] Add mail OAuth provider metadata and scope policy in `backend/src/modules/customerEmail/oauthMailProviders.ts`
- [x] T023 [US1] Add mail-provider OAuth start/status service wrapper in `backend/src/modules/customerEmail/services/customerEmailOAuthService.ts`
- [x] T024 [US1] Add workspace OAuth connection UI state and API calls in `frontend/lib/api-customer-email.ts`
- [x] T025 [US1] Add workspace OAuth connection settings UI in `frontend/components/dashboard/settings/workspace-email-connections-section.tsx`
- [x] T026 [US1] Mount workspace email connections UI in `frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx`

**Checkpoint**: US1 is independently demonstrable with mock OAuth and no email sending.

---

## Phase 4: User Story 2 - Configure a customer-owned email connection (Priority: P1)

**Goal**: Operators create and manage customer email connections backed by authorized OAuth credentials, separate from Radioso transactional mail.

**Independent Test**: Create, list, disable, re-enable, health-check, and delete/block-delete customer email connections without affecting password reset/verification mail.

### Tests for User Story 2

- [x] T027 [P] [US2] Add failing repository tests for customer email connections in `backend/tests/integration/customerEmail/customer-email-connection-repository.test.ts`
- [x] T028 [P] [US2] Add failing service tests for disable/delete/reference rules in `backend/tests/unit/customerEmail/customer-email-connection-service.test.ts`
- [x] T029 [P] [US2] Add failing regression test proving password reset uses `modules/mail` in `backend/tests/unit/auth-email-services.test.ts`
- [x] T030 [P] [US2] Add contract tests for email connection CRUD/status endpoints in `backend/tests/contract/customer-email-connections.contract.test.ts`

### Implementation for User Story 2

- [x] T031 [US2] Add customer email connection domain schemas in `backend/src/modules/customerEmail/domain.ts`
- [x] T032 [US2] Add customer email connection migration in `backend/src/db/migrations/096_customer_email_connections.sql`
- [x] T033 [US2] Add customer email connection repository in `backend/src/db/repositories/customerEmailConnectionRepository.ts`
- [x] T034 [US2] Add customer email connection service in `backend/src/modules/customerEmail/services/customerEmailConnectionService.ts`
- [x] T035 [US2] Add mock customer email provider adapter in `backend/src/modules/customerEmail/providers/mockEmailProvider.ts`
- [x] T036 [US2] Add email connection HTTP routes in `backend/src/app/http/routes/customerEmailConnectionRoutes.ts`
- [x] T037 [US2] Register email connection OpenAPI paths in `backend/src/app/http/openapi/paths/customerEmailPaths.ts`
- [x] T038 [US2] Wire customer email providers and services in `backend/src/app/composition/defaultComposition.ts`
- [x] T039 [US2] Complete connection management UI in `frontend/components/dashboard/settings/workspace-email-connections-section.tsx`

**Checkpoint**: US2 works with mock provider and keeps system transactional mail separate.

---

## Phase 5: User Story 3 - Define an agent email skill (Priority: P2)

**Goal**: Agent authors can define named draft/send email skills over a workspace connection.

**Independent Test**: Create a draft-mode skill with bound/exposed inputs, switch to send mode, and verify only defined skills are callable.

### Tests for User Story 3

- [x] T040 [P] [US3] Add failing domain tests for email skill validation in `backend/tests/unit/customerEmail/email-skill-domain.test.ts`
- [x] T041 [P] [US3] Add failing repository tests for email skill definitions in `backend/tests/integration/customerEmail/email-skill-definition-repository.test.ts`
- [x] T042 [P] [US3] Add contract tests for agent email skill CRUD endpoints in `backend/tests/contract/customer-email-skills.contract.test.ts`
- [x] T043 [P] [US3] Add frontend unit tests for email skill draft builder in `frontend/tests/unit/customer-email-skills.test.ts`

### Implementation for User Story 3

- [x] T044 [US3] Add email skill definition migration in `backend/src/db/migrations/097_email_skill_definitions.sql`
- [x] T045 [US3] Add email skill definition repository in `backend/src/db/repositories/emailSkillDefinitionRepository.ts`
- [x] T046 [US3] Add email skill definition service in `backend/src/modules/customerEmail/services/emailSkillDefinitionService.ts`
- [x] T047 [US3] Add email skill CRUD routes in `backend/src/app/http/routes/emailSkillRoutes.ts`
- [x] T048 [US3] Register email skill OpenAPI paths in `backend/src/app/http/openapi/paths/customerEmailPaths.ts`
- [x] T049 [US3] Add frontend email skill API types and methods in `frontend/lib/api-customer-email.ts`
- [x] T050 [US3] Add non-visual email skill draft builder in `frontend/lib/customer-email-skills.ts`
- [x] T051 [US3] Add agent email skill builder UI in `frontend/components/dashboard/settings/assistant-email-skills-section.tsx`
- [x] T052 [US3] Mount agent email skill builder near external skills in `frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx`

**Checkpoint**: US3 allows creating and editing allowlisted email skills.

---

## Phase 6: User Story 4 - Invoke email skills from routines with typed outcomes (Priority: P2)

**Goal**: Routines invoke email skills through the existing skill executor path and branch on typed outcomes.

**Independent Test**: Routine follows drafted/sent, missing-input, disabled, needs-reauth, and provider-rejected branches without provider logic in routine runtime.

### Tests for User Story 4

- [ ] T053 [P] [US4] Add failing executor tests for email skill outcomes in `backend/tests/unit/customerEmail/email-skill-executor.test.ts`
- [ ] T054 [P] [US4] Add integration tests for routine email skill dispatch in `backend/tests/integration/customerEmail/email-skill-routine-dispatch.test.ts`
- [ ] T055 [P] [US4] Add architecture assertion keeping routine engine provider-free in `backend/tests/unit/customerEmail/email-skill-boundary.test.ts`
- [ ] T056 [P] [US4] Add Playwright routine authoring test for email skill outcome mapping in `frontend/tests/e2e/customer-email-skills.spec.ts`

### Implementation for User Story 4

- [ ] T057 [US4] Add customer email provider port in `backend/src/modules/customerEmail/providers/customerEmailProvider.ts`
- [ ] T058 [US4] Add email skill executor in `backend/src/modules/customerEmail/executor/emailSkillExecutor.ts`
- [ ] T059 [US4] Add routine skill resolver for email skills in `backend/src/modules/customerEmail/routineSkillResolver.ts`
- [ ] T060 [US4] Register email skill executor and resolver in `backend/src/app/server/dependencyBuilders.ts`
- [ ] T061 [US4] Add provider timeout and sanitized error mapping in `backend/src/modules/customerEmail/services/customerEmailDeliveryService.ts`
- [ ] T062 [US4] Add routine authoring support for email skill outcomes in `frontend/lib/customer-email-skills.ts`
- [ ] T063 [US4] Add email skill outcome options to routine UI in `frontend/components/dashboard/settings/assistant-routines-section.tsx`

**Checkpoint**: US4 works end-to-end through routines with typed outcomes.

---

## Phase 7: User Story 5 - Inspect customer email activity safely (Priority: P3)

**Goal**: Operators inspect sanitized email skill activity and reauthorization needs.

**Independent Test**: Drafted, sent, provider-failed, disabled, and needs-reauth outcomes are visible without secrets or full body retention.

### Tests for User Story 5

- [ ] T064 [P] [US5] Add failing repository tests for email skill activity in `backend/tests/integration/customerEmail/email-skill-activity-repository.test.ts`
- [ ] T065 [P] [US5] Add failing redaction tests for activity/audit payloads in `backend/tests/unit/customerEmail/email-skill-activity-redaction.test.ts`
- [ ] T066 [P] [US5] Add contract tests for activity endpoint in `backend/tests/contract/customer-email-activity.contract.test.ts`
- [ ] T067 [P] [US5] Add Playwright test for sanitized activity UI in `frontend/tests/e2e/customer-email-activity.spec.ts`

### Implementation for User Story 5

- [ ] T068 [US5] Add email skill activity migration in `backend/src/db/migrations/097_email_skill_activity.sql`
- [ ] T069 [US5] Add email skill activity repository in `backend/src/db/repositories/emailSkillActivityRepository.ts`
- [ ] T070 [US5] Add sanitized activity mapper in `backend/src/modules/customerEmail/services/emailSkillActivityPresenter.ts`
- [ ] T071 [US5] Record activity from email skill executor in `backend/src/modules/customerEmail/executor/emailSkillExecutor.ts`
- [ ] T072 [US5] Add activity endpoint in `backend/src/app/http/routes/emailSkillActivityRoutes.ts`
- [ ] T073 [US5] Register activity OpenAPI path in `backend/src/app/http/openapi/paths/customerEmailPaths.ts`
- [ ] T074 [US5] Add frontend activity API in `frontend/lib/api-customer-email.ts`
- [ ] T075 [US5] Add sanitized activity UI in `frontend/components/dashboard/settings/customer-email-activity-section.tsx`

**Checkpoint**: US5 gives operators sanitized visibility.

---

## Phase 8: Polish & Cross-Cutting

**Purpose**: Contracts, docs, generated artifacts, and validation.

- [ ] T076 Update skill catalog entries for customer email skills in `backend/src/modules/skills/defaultCatalog.ts`
- [ ] T077 Regenerate OpenAPI artifacts via backend OpenAPI script for `backend/openapi.yaml` and `backend/openapi.json`
- [ ] T078 Update API contract snapshots/tests for generated OpenAPI in `backend/tests/contract/`
- [ ] T079 Read `docs/document-writer-prompt.md` before documentation edits
- [ ] T080 [P] Document workspace email setup in `docs/customer-email-skills.md`
- [ ] T081 [P] Update external skills/routines docs references in `docs/external-skills.md`
- [ ] T082 [P] Update architecture code map if ownership paths changed in `docs/architecture/code-map.md`
- [ ] T083 Verify message-queue impact remains "no queue changes" in `specs/089-workspace-email-skills/contracts/endpoints.md`
- [ ] T084 Run backend focused tests with `cd backend && pnpm test -- tests/unit/customerEmail tests/integration/customerEmail`
- [ ] T085 Run backend contract tests with `cd backend && pnpm run test:contract`
- [ ] T086 Run frontend unit and e2e coverage with `cd frontend && pnpm test -- tests/unit/customer-email-skills.test.ts && pnpm run test:e2e -- customer-email`
- [ ] T087 Run local CI before PR with `pnpm run ci:local -- origin/main`

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup (Phase 1) can start immediately.
- Foundational OAuth boundary (Phase 2) depends on Setup and blocks all user stories.
- US1 and US2 are both P1, but US2 depends on the mail OAuth/provider status from US1.
- US3 depends on US2 because skills reference customer email connections.
- US4 depends on US3 because runtime dispatch needs persisted skill definitions.
- US5 depends on US4 because activity is emitted by runtime execution.
- Polish depends on whichever user stories are implemented.

### MVP Scope

MVP is Phases 1-4: reusable OAuth alignment, authorize mail provider, and configure a customer email connection. This proves the credential boundary and transactional/customer split before skill runtime work begins.

### Parallel Opportunities

- T002-T005 can run in parallel.
- T006-T007 can run in parallel before OAuth implementation.
- US2 repository/service/contract tests can run in parallel.
- US3 domain/repository/contract/frontend tests can run in parallel.
- US5 repository/redaction/contract/Playwright tests can run in parallel.

## Implementation Strategy

1. Complete OAuth extraction/reuse before writing customer email OAuth code.
2. Deliver the connection MVP with a mock provider and one real provider adapter.
3. Add skill definitions and runtime dispatch only after connection status and deletion/reference rules are solid.
4. Keep provider specifics behind adapter ports and composition.
5. Finish with docs, generated OpenAPI artifacts, and local CI.
