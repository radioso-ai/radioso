# Tasks: Account Multi-User Access

## Phase 1: Setup

- [x] T001 Refresh planning artifacts in `specs/036-account-users/plan.md`, `specs/036-account-users/research.md`, `specs/036-account-users/data-model.md`, `specs/036-account-users/contracts/account-users-contract.md`, and `specs/036-account-users/quickstart.md`
- [x] T002 Run `.specify/scripts/bash/update-agent-context.sh codex` from repo root

## Phase 2: Foundational

- [x] T003 Add failing backend tests for multi-user auth bootstrap and invitation lifecycle in `backend/tests/contract/auth.contract.test.ts`, `backend/tests/integration/auth.integration.test.ts`, and `backend/tests/integration/workspace-mgmt.integration.test.ts`
- [x] T004 Add backend unit tests for membership and invitation orchestration in `backend/tests/unit/account-access-service.test.ts` and `backend/tests/unit/account-invitation-service.test.ts`
- [x] T005 Add frontend unit tests for auth bootstrap/account route updates in `frontend/tests/unit/auth-session-bootstrap.test.tsx` and `frontend/tests/unit/dashboard-routes.test.ts`

## Phase 3: User Story 1 - Invite and Manage Account Users (P1)

- [x] T006 [US1] Add multi-user persistence migration in `backend/src/db/migrations/014_account_multi_user.sql`
- [x] T007 [P] [US1] Add repositories for users, memberships, and invitations in `backend/src/db/repositories/userRepository.ts`, `backend/src/db/repositories/accountMembershipRepository.ts`, and `backend/src/db/repositories/accountInvitationRepository.ts`
- [x] T008 [US1] Add account access and invitation services in `backend/src/modules/account/services/accountAccessService.ts` and `backend/src/modules/account/services/accountInvitationService.ts`
- [x] T009 [US1] Add session-authenticated account-user routes in `backend/src/app/http/routes/accountUserRoutes.ts` and wire them in `backend/src/app/http/routes/index.ts`
- [x] T010 [US1] Add Users page API client and view in `frontend/lib/api.ts`, `frontend/components/dashboard/users-view.tsx`, and `frontend/components/dashboard/dashboard-shell.tsx`
- [x] T011 [US1] Add the Users entry under the bottom-left user menu in `frontend/components/dashboard/app-sidebar.tsx`

## Phase 4: User Story 2 - Join an Existing Account Through an Invitation (P1)

- [x] T012 [US2] Extend auth orchestration for users, memberships, sessions, and invitation acceptance in `backend/src/modules/auth/services/authService.ts`
- [x] T013 [US2] Add public invitation routes and schemas in `backend/src/app/http/routes/authRoutes.ts`
- [x] T014 [US2] Add invitation acceptance UI in `frontend/app/invite/[token]/page.tsx` and `frontend/components/auth/invitation-accept-form.tsx`
- [x] T015 [US2] Update frontend auth bootstrap to persist `accountId` alongside `userId` in `frontend/lib/auth-context.tsx`, `frontend/components/auth/login-form.tsx`, `frontend/components/auth/register-form.tsx`, `frontend/app/page.tsx`, and `frontend/components/dashboard/dashboard.tsx`

## Phase 5: User Story 3 - Shared Access Across All Workspaces (P1)

- [x] T016 [US3] Refactor workspace authorization to validate active membership instead of direct ownership in `backend/src/modules/workspace/services/workspaceService.ts`, `backend/src/modules/auth/services/workspaceSessionService.ts`, `backend/src/app/http/middleware/requireSession.ts`, and `backend/src/app/http/middleware/requireWorkspaceSession.ts`
- [x] T017 [US3] Update workspace and account token routes to use the new session/account context in `backend/src/app/http/routes/workspaceRoutes.ts` and `backend/src/app/http/routes/accountRoutes.ts`
- [x] T018 [US3] Update frontend account routing to use the active account context in `frontend/app/account/[accountId]/[[...segments]]/page.tsx` and route helpers that consume auth bootstrap data

## Phase 6: User Story 4 - Users Page in Existing Navigation (P2)

- [x] T019 [US4] Extend dashboard route typing for the Users page in `frontend/lib/dashboard-routes.ts`
- [x] T020 [US4] Add Users page empty states and invite-link presentation in `frontend/components/dashboard/users-view.tsx`

## Phase 7: Polish & Cross-Cutting

- [x] T021 Update the code-first OpenAPI registry in `backend/src/app/http/openapi/document.ts` and regenerate `backend/openapi.yaml` plus `backend/openapi.json`
- [x] T022 Update user-facing documentation in `frontend/README.md`
- [x] T023 Run targeted backend and frontend validation commands and capture the results in the final handoff
- [x] T024 Mark completed tasks in `specs/036-account-users/tasks.md` after implementation
