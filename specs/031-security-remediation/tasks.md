# Tasks: Security Remediation

**Input**: Design documents from `/specs/031-security-remediation/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/admin-session-auth-contract.md, quickstart.md

**Tests**: Backend tests are REQUIRED per constitution (TDD). Backend test tasks MUST be written and fail before implementation. Frontend tests are included for session/bootstrap behavior because browser credential storage is part of the feature scope.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each remediation slice.

**Architecture**: Keep admin trust rooted in the account session cookie, introduce shared workspace-session and abuse-control seams before route changes, keep route files transport-only, and keep connector hardening inside the connectors module rather than scattering security policy across plugins.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Create the shared scaffolding and configuration surfaces for the remediation feature

- [x] T001 Add abuse-control migration scaffold in `backend/src/db/migrations/010_abuse_controls.sql`
- [x] T002 Update configuration examples and env parsing notes in `backend/.env.example` and `backend/src/app/config/env.ts`
- [x] T003 Create task-aligned quick validation placeholders in `specs/031-security-remediation/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared seams that all user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

- [x] T004 [P] Unit test durable abuse-control repository behavior in `backend/tests/unit/abuse-control-repository.test.ts`
- [x] T005 [P] Unit test abuse-control service policy evaluation in `backend/tests/unit/abuse-control-service.test.ts`
- [x] T006 [P] Unit test session-authenticated workspace resolution in `backend/tests/unit/workspace-session-service.test.ts`
- [x] T007 [P] Frontend unit test legacy credential cleanup/bootstrap behavior in `frontend/tests/unit/auth-session-bootstrap.test.tsx`

### Implementation for Foundational

- [x] T008 [P] Implement durable abuse-control repository in `backend/src/db/repositories/abuseControlRepository.ts`
- [x] T009 [P] Implement shared abuse-control service in `backend/src/modules/security/services/abuseControlService.ts`
- [x] T010 [P] Implement session-authenticated workspace service in `backend/src/modules/auth/services/workspaceSessionService.ts`
- [x] T011 [P] Implement session-authenticated workspace middleware in `backend/src/app/http/middleware/requireWorkspaceSession.ts`
- [x] T012 [P] Implement shared rate-limit transport middleware/helpers in `backend/src/app/http/middleware/rateLimit.ts`
- [x] T013 Wire abuse-control and workspace-session dependencies in `backend/src/app/server/dependencies.ts` and `backend/src/app/server/types.ts`
- [x] T014 Update test fakes and app wiring helpers for the new auth/security seams in `backend/tests/support/fakes.ts` and `backend/tests/support/testApp.ts`

**Checkpoint**: Shared auth and abuse-control seams exist, are test-covered, and can be reused by each story without adding policy logic directly to route files.

---

## Phase 3: User Story 1 - Protect Stored Credentials and Sessions (Priority: P1) 🎯 MVP

**Goal**: Remove persistent browser workspace bearer tokens and fail closed on unsafe connector secret handling while preserving multi-workspace admin behavior.

**Independent Test**: Sign in, switch workspaces, refresh the browser, and verify admin flows still work without reusable workspace bearer tokens in persistent browser storage. Attempt connector secret writes without valid encryption config and verify the system blocks them safely.

### Tests for User Story 1 (REQUIRED)

- [x] T015 [P] [US1] Contract test admin session-authenticated workspace context in `backend/tests/contract/auth.contract.test.ts`
- [x] T016 [P] [US1] Integration test multi-workspace session flow in `backend/tests/integration/auth-session.integration.test.ts`
- [x] T017 [P] [US1] Unit test connector secret fail-closed behavior in `backend/tests/unit/connectors/configEncryption.test.ts`
- [x] T018 [P] [US1] Frontend unit test workspace bootstrap without bearer token persistence in `frontend/tests/unit/workspace-session.test.tsx`

### Implementation for User Story 1

- [x] T019 [US1] Refactor admin auth routes to use session-authenticated workspace context in `backend/src/app/http/routes/accountRoutes.ts`, `backend/src/app/http/routes/workspaceRoutes.ts`, `backend/src/app/http/routes/documentRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, and `backend/src/app/http/routes/chatRoutes.ts`
- [x] T020 [US1] Update auth service/session helpers to support workspace selection without browser bearer tokens in `backend/src/modules/auth/services/authService.ts` and `backend/src/modules/auth/domain/authPrimitives.ts`
- [x] T021 [US1] Harden connector secret storage to reject writes without valid encryption config in `backend/src/modules/connectors/services/connectorRegistry.ts` and `backend/src/modules/connectors/services/configEncryption.ts`
- [x] T022 [US1] Implement legacy connector-secret remediation state and operator-visible handling in `backend/src/modules/connectors/services/connectorRegistry.ts` and `backend/src/modules/connectors/http/connectorRoutes.ts`
- [x] T023 [US1] Replace browser workspace token persistence with session-based workspace selection in `frontend/lib/api.ts`, `frontend/lib/auth-context.tsx`, and `frontend/lib/workspace-context.tsx`
- [x] T024 [US1] Update admin bootstrap and workspace-switching UI flows for the new session-authenticated model in `frontend/app/account/[accountId]/[[...segments]]/page.tsx` and related dashboard components under `frontend/components/dashboard/`

**Checkpoint**: Admin flows no longer rely on persistent browser bearer tokens, connector secret writes fail closed, and legacy connector-secret records surface explicit remediation state.

---

## Phase 4: User Story 2 - Resist Common Abuse and Denial Attempts (Priority: P1)

**Goal**: Enforce durable, shared abuse controls on auth-sensitive, upload, and anonymous chat entry points.

**Independent Test**: Exceed thresholds for login, registration, workspace-session/token-sensitive endpoints, uploads, and anonymous chat; verify that limits are enforced consistently across restarts or multiple instances.

### Tests for User Story 2 (REQUIRED)

- [x] T025 [P] [US2] Contract test auth throttling behavior in `backend/tests/contract/auth.contract.test.ts`
- [x] T026 [P] [US2] Contract test upload throttling behavior in `backend/tests/contract/document.contract.test.ts`
- [x] T027 [P] [US2] Contract test anonymous chat durable throttling in `backend/tests/contract/public-chat.contract.test.ts`
- [x] T028 [P] [US2] Integration test multi-instance or restart-safe abuse-control enforcement in `backend/tests/integration/abuse-controls.integration.test.ts`

### Implementation for User Story 2

- [x] T029 [US2] Apply shared abuse-control middleware to registration and login in `backend/src/app/http/routes/authRoutes.ts`
- [x] T030 [US2] Apply shared abuse-control middleware to session-sensitive admin endpoints in `backend/src/app/http/routes/accountRoutes.ts` and `backend/src/app/http/routes/workspaceRoutes.ts`
- [x] T031 [US2] Apply shared abuse-control middleware to authenticated upload acceptance in `backend/src/app/http/routes/documentRoutes.ts`
- [x] T032 [US2] Replace process-local anonymous chat throttling with durable shared enforcement in `backend/src/app/http/middleware/anonymousRateLimiter.ts` and `backend/src/app/http/routes/publicChatRoutes.ts`
- [x] T033 [US2] Record auditable rate-limit enforcement and unavailable-state failures in `backend/src/modules/audit/services/auditService.ts` and the touched route/service layers

**Checkpoint**: Abuse controls are durable, shared, and auditable across all scoped entry points.

---

## Phase 5: User Story 3 - Remove Reachable Known Vulnerabilities (Priority: P2)

**Goal**: Clear the confirmed reachable dependency advisories on the backend import path, route-matching path, and frontend framework line.

**Independent Test**: Rebuild and audit the production dependency graph, then exercise spreadsheet import, admin API routes, and the frontend app without regression.

### Tests for User Story 3 (REQUIRED)

- [x] T034 [P] [US3] Unit test replacement spreadsheet extraction behavior in `backend/tests/unit/document-import-service.test.ts`
- [x] T035 [P] [US3] Integration test supported spreadsheet import on the remediated parser path in `backend/tests/integration/document-import.integration.test.ts`
- [x] T036 [P] [US3] Frontend smoke coverage for the upgraded framework line in `frontend/tests/unit/onboarding.test.ts` and `frontend/tests/unit/chat-markdown.test.tsx`

### Implementation for User Story 3

- [x] T037 [US3] Replace the vulnerable spreadsheet parsing path in `packages/document-parser/package.json` and spreadsheet parser implementation files under `packages/document-parser/`
- [x] T038 [US3] Refresh backend production dependencies and lockfile for the remediated routing/import graph in `backend/package.json` and `backend/package-lock.json`
- [x] T039 [US3] Upgrade frontend framework dependencies to the patched supported line in `frontend/package.json` and `frontend/package-lock.json`
- [x] T040 [US3] Verify backend import and routing wiring still matches the remediated dependency graph in `backend/src/modules/documents/services/documentImportService.ts`, `backend/src/app/server/createApp.ts`, and related parser integration files

**Checkpoint**: The confirmed reachable dependency findings are removed or reduced to explicitly documented residual risk with validated compensating control.

---

## Phase 6: User Story 4 - Preserve Safe Operations During Rollout (Priority: P3)

**Goal**: Give operators a safe rollout path for legacy connector-secret state, active sessions, and any contract changes introduced by the remediation.

**Independent Test**: Follow the staging rollout steps with pre-existing sessions and connector records and verify operators do not need undocumented manual intervention.

### Tests for User Story 4 (REQUIRED)

- [x] T041 [P] [US4] Integration test legacy connector-secret remediation flow in `backend/tests/integration/connectors/legacy-secret-remediation.integration.test.ts`
- [x] T042 [P] [US4] Integration test active-session migration/bootstrap behavior in `backend/tests/integration/runtime-entrypoints.integration.test.ts`

### Implementation for User Story 4

- [x] T043 [US4] Update code-first OpenAPI auth/context definitions in `backend/src/app/http/openapi/document.ts`
- [x] T044 [US4] Regenerate generated API artifacts in `backend/openapi.yaml` and `backend/openapi.json`
- [x] T045 [US4] Update rollout and migration guidance in `specs/031-security-remediation/quickstart.md` and any affected operator docs
- [x] T046 [US4] Add explicit startup or runtime messaging for unsafe legacy security state in `backend/src/app/server/dependencies.ts` and related admin-facing presentation paths

**Checkpoint**: Operators can roll out the remediation safely with clear guidance and generated contracts aligned to runtime behavior.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup across all remediation slices

- [x] T047 [P] Run targeted backend unit, contract, and integration suites for auth, documents, connectors, and public chat in `backend/tests/`
- [x] T048 [P] Run targeted frontend test suites for auth/bootstrap and upgraded framework behavior in `frontend/tests/unit/`
- [x] T049 Run dependency audit verification for backend and frontend production trees from `backend/` and `frontend/`
- [x] T050 Run the full staging validation flow from `specs/031-security-remediation/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and benefits from the shared seams established for US1, but remains independently testable
- **User Story 3 (Phase 5)**: Depends on Foundational completion and can proceed in parallel with US1/US2 once shared seams are stable
- **User Story 4 (Phase 6)**: Depends on US1-US3 behavior being defined
- **Polish (Phase 7)**: Depends on all desired stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start immediately after Foundational; this is the MVP slice because it removes the browser token and plaintext-secret risks
- **User Story 2 (P1)**: Can start after Foundational; uses the same abuse-control seam but does not require US3
- **User Story 3 (P2)**: Can start after Foundational; dependency work is mostly isolated to packages and lockfiles
- **User Story 4 (P3)**: Depends on the final contract and runtime behavior from US1-US3

### Within Each User Story

- Backend tests MUST be written and fail before implementation
- Shared seams and focused modules land before route-by-route wiring
- Persistence before service logic
- Service logic before route or UI integration
- OpenAPI changes after runtime behavior is finalized, but before final validation

### Parallel Opportunities

- T004-T007 can run in parallel
- T008-T012 can run in parallel once the test intent is set
- Within US1, T015-T018 can run in parallel, then T021 and T023 can proceed alongside each other before final route/UI integration
- Within US2, T025-T028 can run in parallel, then T029-T033 can be split by route area
- Within US3, T034-T036 can run in parallel, and T037-T039 can be split across package/backend/frontend ownership

---

## Parallel Example: User Story 1

```bash
# Launch test authoring in parallel:
Task: "Contract test admin session-authenticated workspace context in backend/tests/contract/auth.contract.test.ts"
Task: "Integration test multi-workspace session flow in backend/tests/integration/auth-session.integration.test.ts"
Task: "Unit test connector secret fail-closed behavior in backend/tests/unit/connectors/configEncryption.test.ts"
Task: "Frontend unit test workspace bootstrap without bearer token persistence in frontend/tests/unit/workspace-session.test.tsx"

# Launch implementation slices in parallel after tests are in place:
Task: "Harden connector secret storage in backend/src/modules/connectors/services/connectorRegistry.ts and backend/src/modules/connectors/services/configEncryption.ts"
Task: "Replace browser workspace token persistence in frontend/lib/api.ts, frontend/lib/auth-context.tsx, and frontend/lib/workspace-context.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: confirm persistent browser bearer tokens are gone and connector secret writes fail closed

### Incremental Delivery

1. Foundational seams first
2. US1 removes the highest-value credential risks
3. US2 adds durable abuse controls
4. US3 clears the confirmed reachable dependency advisories
5. US4 locks rollout and contract safety
6. Finish with full validation and audit re-check

### Parallel Team Strategy

After Phase 2:

- Engineer A: US1 auth/session and frontend bootstrap work
- Engineer B: US2 abuse-control persistence and route enforcement
- Engineer C: US3 parser and dependency remediation
- Integrator: US4 rollout, contract regeneration, and final validation

---

## Notes

- [P] tasks = different files, no incomplete-task dependency
- [Story] labels map tasks to the approved spec for traceability
- Route files must stay transport-only; if a task starts pushing policy logic into a route, extract it instead
- `backend/src/app/http/openapi/document.ts` is the source of truth for HTTP contract changes
- `backend/openapi.yaml` and `backend/openapi.json` are generated artifacts, not hand-authored design inputs
