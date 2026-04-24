# Tasks: Workspace-First Dashboard URLs

**Input**: Design documents from `/specs/049-workspace-route-keys/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/workspace-route-resolution.md

**Tests**: Backend tests are required and must fail before implementation. Frontend unit coverage is included for canonical route building, canonical entry, and legacy redirect behavior.

**Organization**: Tasks are grouped by user story and architecture seam so canonical routing, account restoration, and compatibility work can land in independently testable slices.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add design artifacts and shared typing seams needed across the feature.

- [x] T001 Add workspace public-route-key planning and validation notes to `specs/049-workspace-route-keys/plan.md`, `research.md`, `data-model.md`, `contracts/workspace-route-resolution.md`, and `quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish persistence and shared routing seams before user-story work.

- [x] T002 Add a migration for immutable workspace public route keys in `backend/src/db/migrations/`
- [x] T003 [P] Extend workspace repository records and lookup methods in `backend/src/db/repositories/workspaceRepository.ts`
- [x] T004 [P] Add workspace public-route-key generation and resolution behavior in `backend/src/modules/workspace/services/workspaceService.ts`
- [x] T005 [P] Add shared backend test doubles support for workspace public route keys in `backend/tests/support/fakes.ts` and related helpers
- [x] T006 [P] Split dashboard route helpers into canonical workspace-first and legacy-account forms in `frontend/lib/dashboard-routes.ts`

**Checkpoint**: Shared persistence and route seams exist; user stories can build on them.

---

## Phase 3: User Story 1 - Open and share readable workspace links (Priority: P1) 🎯 MVP

**Goal**: Authenticated dashboard navigation uses canonical workspace-first URLs with readable public route keys.

**Independent Test**: Sign in, navigate the dashboard, and verify canonical URLs stay under `/w/<workspace-key>/...` while preserving supported deep-link state.

### Tests for User Story 1

- [x] T007 [P] [US1] Add backend unit tests for workspace public-route-key generation and workspace list payloads in `backend/tests/unit/workspace-service.test.ts`
- [x] T008 [P] [US1] Add frontend unit tests for canonical workspace-first URL building/parsing in `frontend/tests/unit/dashboard-routes.test.ts`
- [ ] T009 [P] [US1] Add frontend unit tests for canonical dashboard entry behavior in `frontend/tests/unit/workspace-route-page.test.tsx`

### Implementation for User Story 1

- [x] T010 [US1] Return `publicRouteKey` from workspace list/create/rename flows in `backend/src/app/http/routes/workspaceRoutes.ts`, `backend/src/app/server/types.ts`, and `backend/src/app/server/dependencies.ts`
- [x] T011 [US1] Add `workspacePublicRouteKey` to login-adjacent auth/account responses in `backend/src/modules/auth/services/authService.ts`, `backend/src/app/http/routes/authRoutes.ts`, and `backend/src/app/http/routes/accountUserRoutes.ts`
- [x] T012 [US1] Update the code-first OpenAPI registry and regenerate generated specs in `backend/src/app/http/openapi/document.ts`, `backend/scripts/generateOpenApi.ts`, `backend/openapi.yaml`, and `backend/openapi.json`
- [x] T013 [US1] Extend frontend API/client types with public route key support in `frontend/lib/api.ts`
- [x] T014 [US1] Add canonical `/w/[workspaceKey]/[[...segments]]/page.tsx` and update root/auth post-login landings in `frontend/app/page.tsx`, `frontend/components/dashboard/dashboard.tsx`, `frontend/components/auth/login-form.tsx`, `frontend/components/auth/reset-password-screen.tsx`, and `frontend/components/auth/invitation-accept-form.tsx`
- [x] T015 [US1] Update dashboard shell and navigation components to build canonical workspace-first URLs in `frontend/components/dashboard/dashboard-shell.tsx`, `frontend/components/dashboard/app-sidebar.tsx`, `frontend/components/dashboard/workspace-switcher.tsx`, and related dashboard views

**Checkpoint**: Canonical authenticated dashboard navigation uses workspace-first URLs with readable public keys.

---

## Phase 4: User Story 2 - Keep old dashboard links working (Priority: P1)

**Goal**: Existing account-scoped dashboard links redirect cleanly to the canonical workspace-first route without losing supported deep-link state.

**Independent Test**: Open representative legacy `/account/...` links and verify the app redirects to the matching canonical `/w/...` URL with equivalent destination state.

### Tests for User Story 2

- [ ] T016 [P] [US2] Add frontend unit tests for legacy-account route redirect behavior in `frontend/tests/unit/legacy-dashboard-route.test.tsx`
- [ ] T017 [P] [US2] Add frontend unit tests for fallback handling when legacy route workspace state is missing or stale in `frontend/tests/unit/workspace-context.test.ts`

### Implementation for User Story 2

- [x] T018 [US2] Convert `frontend/app/account/[accountId]/[[...segments]]/page.tsx` into a redirect-only legacy transport seam that preserves supported deep-link state
- [x] T019 [US2] Update canonical route helpers and section views to preserve document/history/settings deep-link state during redirect and navigation in `frontend/lib/dashboard-routes.ts` and affected dashboard components

**Checkpoint**: Legacy dashboard links remain usable through canonical redirects.

---

## Phase 5: User Story 3 - Resolve the right organization automatically from the workspace link (Priority: P1)

**Goal**: A canonical workspace-first URL restores the correct organization/account context for multi-organization users before rendering dashboard content.

**Independent Test**: Open a canonical workspace link for a workspace in a non-current organization and verify the app restores the correct account session and active workspace automatically.

### Tests for User Story 3

- [x] T020 [P] [US3] Add backend integration/contract tests for authenticated workspace-key resolution in `backend/tests/integration/workspace-route-resolution.integration.test.ts` and `backend/tests/contract/auth.contract.test.ts`
- [ ] T021 [P] [US3] Add frontend unit tests for canonical workspace resolution and account switching orchestration in `frontend/tests/unit/workspace-route-resolution.test.tsx`

### Implementation for User Story 3

- [x] T022 [US3] Add an authenticated workspace-key resolution route in `backend/src/app/http/routes/workspaceRoutes.ts` and wire it through `backend/src/app/http/routes/index.ts`
- [x] T023 [US3] Implement signed-in workspace-key access validation and resolution flow in `backend/src/modules/workspace/services/workspaceService.ts` and supporting auth/account services as needed
- [x] T024 [US3] Extend frontend API helpers and workspace bootstrap/account switching orchestration for canonical route entry in `frontend/lib/api.ts`, `frontend/lib/workspace-context.tsx`, and `frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx`

**Checkpoint**: Canonical workspace links restore the right organization and workspace automatically for accessible targets.

---

## Phase 6: User Story 4 - Keep workspace identifiers readable without changing internal IDs (Priority: P2)

**Goal**: Public route keys stay stable and readable while UUIDs remain the internal persistence identifier.

**Independent Test**: Create and rename workspaces, then verify internal UUID-based APIs continue working while canonical URLs continue to use stable public route keys.

### Tests for User Story 4

- [x] T025 [P] [US4] Add backend unit tests for immutable public-route-key behavior during workspace create/rename flows in `backend/tests/unit/workspace-service.test.ts`
- [ ] T026 [P] [US4] Add frontend unit tests that canonical URLs continue using public route keys after workspace rename in `frontend/tests/unit/workspace-switcher.test.tsx`

### Implementation for User Story 4

- [x] T027 [US4] Finalize create/rename flows to preserve immutable public route keys in `backend/src/modules/workspace/services/workspaceService.ts` and `backend/src/db/repositories/workspaceRepository.ts`
- [x] T028 [US4] Update workspace management UI and client state to rely on stable public route keys without exposing UUIDs in links in `frontend/components/dashboard/workspace-switcher.tsx`, `frontend/lib/api.ts`, and related workspace tests

**Checkpoint**: Readable public route keys are stable while internal UUID-based behavior remains unchanged.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, validation, and final parity.

- [x] T029 [P] Update routing/auth bootstrap documentation in `readme.md` and any affected docs under `docs/`
- [x] T030 [P] Run targeted backend/frontend validation and record results in `specs/049-workspace-route-keys/quickstart.md`
- [x] T031 Mark completed tasks in `specs/049-workspace-route-keys/tasks.md` and confirm spec/plan/doc parity

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: starts immediately
- **Foundational (Phase 2)**: depends on setup and blocks all user stories
- **US1-US4 (Phases 3-6)**: depend on foundational persistence and route seams
- **Polish (Phase 7)**: depends on all implemented stories

### User Story Dependencies

- **US1** depends on foundational workspace public-key and route-builder seams
- **US2** depends on US1 canonical route helpers
- **US3** depends on foundational workspace public-key persistence and can then extend US1 canonical entry behavior
- **US4** depends on foundational persistence plus US1 create/rename response shaping

### Within Each User Story

- Backend tests fail before backend implementation.
- Frontend route tests fail before route-entry and navigation updates.
- OpenAPI changes land with the backend contract changes, not later.
- Legacy route support remains redirect-only rather than reintroducing a second canonical route builder.

### Parallel Opportunities

- T003, T004, T005, and T006 can proceed in parallel once the migration shape is defined.
- Backend and frontend tests inside each story can be authored in parallel.
- US2 legacy redirect work and US3 backend route-resolution work can proceed in parallel once US1 canonical route helpers stabilize.

## Implementation Strategy

### MVP First

1. Complete setup and foundational workspace public-key seams.
2. Deliver US1 canonical workspace-first URLs.
3. Deliver US2 compatibility redirects.
4. Deliver US3 multi-organization restoration.
5. Finish US4 stability guarantees and polish.

### Incremental Delivery

1. Add persistence and route helpers.
2. Switch canonical navigation to workspace-first URLs.
3. Preserve old links through redirects.
4. Add account restoration for cross-organization canonical entry.
5. Finalize stable public-key behavior and documentation.
