# Tasks: Password Reset Email Recovery

**Input**: Design documents from `/specs/045-password-reset-email/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/password-reset.md

**Tests**: Backend tests are required and must be written before implementation. Frontend unit coverage is included for the new auth recovery UI and API client behavior.

**Organization**: Tasks are grouped by user story and architecture seams so each slice stays independently testable and aligned with module ownership.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the feature artifacts and config seams that all stories rely on.

- [x] T001 Add mail-driver environment variables and validation in `backend/src/app/config/env.ts` and `backend/.env.example`
- [x] T002 [P] Add password reset and email module ownership notes to `specs/045-password-reset-email/plan.md`, `research.md`, `data-model.md`, `contracts/password-reset.md`, and `quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish persistence and reusable module seams before user-story work.

- [x] T003 Add a migration for `password_reset_tokens` in `backend/src/db/migrations/`
- [x] T004 [P] Add repository ports and persistence support for password updates and session revocation in `backend/src/db/repositories/userRepository.ts` and `backend/src/db/repositories/sessionRepository.ts`
- [x] T005 [P] Add `backend/src/db/repositories/passwordResetTokenRepository.ts` for reset token lifecycle persistence
- [x] T006 [P] Add a reusable email module under `backend/src/modules/email/` with typed message contracts and driver interfaces
- [x] T007 Wire the new repositories and email service into `backend/src/app/server/dependencies.ts` and `backend/src/app/server/types.ts`

**Checkpoint**: Persistence and reusable email seams exist; user stories can build on them.

---

## Phase 3: User Story 1 - Request Password Reset (Priority: P1) 🎯 MVP

**Goal**: A signed-out user can request password reset safely through the shared email module without revealing account existence.

**Independent Test**: Submit reset requests for known and unknown emails and verify the same outward response while only known users trigger reset-token creation and email delivery.

### Tests for User Story 1

- [x] T008 [P] [US1] Add service-level failing tests for reset request behavior in `backend/tests/unit/password-reset-service.test.ts`
- [x] T009 [P] [US1] Add route/integration failing tests for request flow and abuse controls in `backend/tests/integration/password-reset.integration.test.ts`

### Implementation for User Story 1

- [x] T010 [P] [US1] Add password reset domain helpers in `backend/src/modules/auth/domain/`
- [x] T011 [US1] Implement reset request orchestration in `backend/src/modules/auth/services/passwordResetService.ts`
- [x] T012 [US1] Add request schemas and routes in `backend/src/app/http/routes/authRoutes.ts`
- [x] T013 [US1] Add password reset request OpenAPI entries in `backend/src/app/http/openapi/document.ts`
- [x] T014 [US1] Extend backend test doubles in `backend/tests/support/fakes.ts` and `backend/tests/support/testApp.ts` for reset tokens and email delivery

**Checkpoint**: Reset requests are uniform, auditable, and use the shared email module.

---

## Phase 4: User Story 2 - Reset Password And Restore Access (Priority: P1)

**Goal**: A user with a valid reset link can set a new password, get a fresh session, and land in an already accessible account context.

**Independent Test**: Complete a reset with a valid token and confirm the user can authenticate with the new password while invalid or used tokens fail safely.

### Tests for User Story 2

- [x] T015 [P] [US2] Add failing tests for reset confirmation and stale-token handling in `backend/tests/unit/password-reset-service.test.ts`
- [x] T016 [P] [US2] Add failing integration tests for confirmation success and invalid-token responses in `backend/tests/integration/password-reset.integration.test.ts`
- [x] T017 [P] [US2] Add frontend failing tests for reset request/confirm UI states in `frontend/tests/unit/password-reset-flow.test.tsx`

### Implementation for User Story 2

- [x] T018 [US2] Implement reset confirmation orchestration in `backend/src/modules/auth/services/passwordResetService.ts`
- [x] T019 [US2] Add confirmation route, schemas, and response shaping in `backend/src/app/http/routes/authRoutes.ts`
- [x] T020 [US2] Extend `frontend/lib/api.ts` with password reset request/confirm methods
- [x] T021 [US2] Add reset request and reset confirmation UI under `frontend/components/auth/` and `frontend/app/reset-password/`
- [x] T022 [US2] Update the login entry point in `frontend/components/auth/login-form.tsx` and `frontend/components/auth/auth-page.tsx` to expose the recovery flow
- [x] T023 [US2] Add confirmation OpenAPI entries and regenerate generated specs through `backend/src/app/http/openapi/document.ts`, `backend/scripts/generateOpenApi.ts`, `backend/openapi.yaml`, and `backend/openapi.json`

**Checkpoint**: A user can complete recovery end-to-end and regain access through the existing auth bootstrap.

---

## Phase 5: User Story 3 - Revoke Existing Sessions After Reset (Priority: P1)

**Goal**: All previously issued sessions for a user stop working immediately after successful reset.

**Independent Test**: Keep an old session active, complete password reset, and verify the old session can no longer authorize a protected request.

### Tests for User Story 3

- [x] T024 [P] [US3] Add failing tests for session revocation behavior in `backend/tests/unit/password-reset-service.test.ts`
- [x] T025 [P] [US3] Add failing integration coverage for revoked old cookies in `backend/tests/integration/password-reset.integration.test.ts`

### Implementation for User Story 3

- [x] T026 [US3] Extend session repository revocation behavior in `backend/src/db/repositories/sessionRepository.ts` and supporting fakes in `backend/tests/support/fakes.ts`
- [x] T027 [US3] Complete revoke-all-on-success behavior in `backend/src/modules/auth/services/passwordResetService.ts`
- [x] T028 [US3] Ensure existing auth/session middleware continues to reject revoked sessions via `backend/src/modules/auth/services/authService.ts` and related tests if needed

**Checkpoint**: Old sessions reliably fail after password reset.

---

## Phase 6: User Story 4 - Reusable Email Delivery Module (Priority: P2)

**Goal**: Password reset uses a reusable email module with configurable drivers instead of auth-specific transport code.

**Independent Test**: Switch the email driver configuration and confirm password reset still routes through the same shared email capability.

### Tests for User Story 4

- [x] T029 [P] [US4] Add failing unit tests for email service driver selection and password reset message composition in `backend/tests/unit/email-service.test.ts`

### Implementation for User Story 4

- [x] T030 [US4] Implement provider-agnostic email composition and driver selection under `backend/src/modules/email/`
- [x] T031 [US4] Integrate password reset message building with the shared email module in `backend/src/modules/auth/services/passwordResetService.ts`

**Checkpoint**: Password reset email delivery is reusable and provider-agnostic.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and final readiness.

- [x] T032 [P] Update operator and local-run documentation in `readme.md`
- [x] T033 [P] Run targeted backend/frontend validation and record results in `specs/045-password-reset-email/quickstart.md`
- [x] T034 Mark completed tasks in `specs/045-password-reset-email/tasks.md` and confirm artifact parity

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: starts immediately
- **Foundational (Phase 2)**: depends on setup and blocks all user stories
- **User Stories (Phases 3-6)**: depend on foundational seams
- **Polish (Phase 7)**: depends on all implemented stories

### User Story Dependencies

- **US1** depends on foundational persistence/email seams
- **US2** depends on US1 request flow and shared email module
- **US3** depends on US2 confirmation flow
- **US4** depends on foundational email seam and finalizes reuse guarantees for US1/US2

### Within Each User Story

- Backend tests fail before implementation.
- Route/OpenAPI work lands after the underlying service behavior exists.
- Frontend reset UI lands after backend contracts are stable enough to target.

### Parallel Opportunities

- T004, T005, and T006 can proceed in parallel once the migration shape is clear.
- Backend service tests and integration tests can be authored in parallel within each story.
- Frontend API client and UI work can proceed in parallel once confirmation contracts are stable.

## Implementation Strategy

### MVP First

1. Complete setup and foundational seams.
2. Deliver US1 reset request flow.
3. Deliver US2 confirmation flow.
4. Deliver US3 session revocation guarantees.
5. Validate end-to-end before treating US4 as polish on the reusable email seam.

### Incremental Delivery

1. Land persistence and shared module seams.
2. Add request flow.
3. Add confirm flow and UI.
4. Add session revocation hardening.
5. Finalize reusable email behavior and docs.
