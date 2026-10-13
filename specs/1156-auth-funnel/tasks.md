# Tasks: Auth Funnel Completion

## Phase 1: Specification And Discovery

- [x] T001 Validate issue #1156 against PR #1430 and current auth code.
- [x] T002 Record boundaries, ports, dependency direction, observability, queue impact, and Copilot exclusion in the plan.

## Phase 2: Backend Red Tests

- [x] T003 [US2] Add failing integration/contract tests for session-on-verify, expiry/replay, and development URL response.
- [x] T004 [US3] Add failing integration/contract tests for pending-cookie issuance, constant-shape polling, expiry/replay, and rate limiting.

## Phase 3: Backend Implementation

- [x] T005 [US2] Add migration 217 and atomic auth-funnel repository/service boundaries.
- [x] T006 [US2] Update verification transport to set the existing secure session cookie.
- [x] T007 [US3] Issue and exchange pending tickets through httpOnly cookies and the existing abuse-control middleware.
- [x] T008 [US4] Add development-only verification URL configuration and response behavior.
- [x] T009 Regenerate Kysely types/schema and public OpenAPI/SDK/MCP artifacts.

## Phase 4: Frontend

- [x] T010 [US1] Add `/login` and `/signup`, keep `/`, and redirect authenticated visitors.
- [x] T011 [US3] Poll the pending exchange from the inbox screen and navigate after session issuance.
- [x] T012 [US2] Navigate a successfully verified link into the authenticated app.
- [x] T013 [US4] Render the development link and reuse Google availability/start behavior on registration.
- [x] T014 Add Playwright coverage for visible journeys.

## Phase 5: Documentation And Delivery

- [x] T015 Read the documentation prompt and update auth/setup documentation.
- [x] T016 Run all required focused tests and repository gates.
- [x] T017 Perform senior review and engineering-manager scope/readiness review in this session.
- [x] T018 Commit, push, and open the PR with exact validation and security notes.
- [x] T019 Address recovery, ticket-activation, polling-budget, mixed-revision, and return-path review findings with regression coverage.
