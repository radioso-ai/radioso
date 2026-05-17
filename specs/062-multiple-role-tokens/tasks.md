# Tasks: Token Authorization Phase 1

**Input**: Design documents from `/specs/062-multiple-role-tokens/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md)

## Phase 1: Tests First

- [x] T001 [P] [US1] Add middleware unit coverage proving bearer-authenticated requests call `AccountAccessService.requirePermission` in `backend/tests/unit/require-permission-middleware.test.ts`.
- [x] T002 [P] [US2] Add contract coverage proving public chat launch credentials are rejected as workspace API bearer tokens in `backend/tests/contract/token-authorization.contract.test.ts`.
- [x] T003 [P] [US2] Add contract coverage proving website embed launch credentials are rejected as workspace API bearer tokens in `backend/tests/contract/token-authorization.contract.test.ts`.
- [x] T004 [P] [US3] Add mixed-auth precedence coverage for valid session plus invalid bearer and stale session plus valid bearer in `backend/tests/contract/token-authorization.contract.test.ts`.

## Phase 2: Principal and Permission Model

- [x] T005 [US1] Add explicit authenticated principal types in `backend/src/modules/account/services/accountAccessService.ts`.
- [x] T006 [US1] Return a workspace API token principal from `AuthService.authenticateApiToken` in `backend/src/modules/auth/services/authService.ts`.
- [x] T007 [US1] Attach session-user and workspace-api-token principals in `requireWorkspaceSession.ts` and `requireApiToken.ts`.
- [x] T008 [US1] Remove the bearer-token bypass from `requireWorkspacePermission.ts`.
- [x] T009 [US1] Evaluate workspace API token principals through `AccountAccessService` and disallow token-management permissions for token principals.

## Phase 3: Route Permission Declarations

- [x] T010 [US1] Add explicit workspace permissions to assistant and retrieval routes.
- [x] T011 [US1] Add explicit workspace permissions to history, skills, workspace summary, and settings read routes.
- [x] T012 [US1] Add explicit workspace permissions to document read/search routes and website crawler routes.
- [x] T013 [US1] Add explicit workspace permissions to agent read/manage routes while keeping delete separately permissioned.

## Phase 4: Documentation and Follow-Up

- [x] T014 [US2] Update MCP, SDK, and crawler docs to distinguish secret workspace API tokens from public launch credentials.
- [x] T015 [US1] Record message-queue impact review in `plan.md`.
- [x] T016 [US2] Create GitHub follow-up issue for Phase 2 productization.

## Phase 5: Validation

- [x] T017 Run focused token authorization unit and contract tests.
- [x] T018 Run relevant auth, settings, agents, documents, account roles, and website crawler route tests.
- [x] T019 Run backend build.
