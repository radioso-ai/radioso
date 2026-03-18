# Tasks: Workspace Management (Rename & Delete)

**Input**: Design documents from `/specs/016-workspace-mgmt/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED per constitution (TDD). Tests appear before implementation tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Architecture**: All tasks preserve module ownership from plan.md — transport in routes, orchestration in service, persistence in repository, presentation in React components.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No new project setup needed — extending existing modules. Only DI wiring change.

- [x] T001 Update `WorkspaceService` constructor to accept `auditService` dependency in `backend/src/modules/workspace/services/workspaceService.ts`
- [x] T002 Wire `auditService` into `WorkspaceService` instantiation in `backend/src/app/server/dependencies.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Repository method that both user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

- [x] T003 Write failing test for `updateName(workspaceId, name)` repository method in `backend/tests/integration/workspace-mgmt.test.ts`

### Implementation for Foundational

- [x] T004 Add `updateName(workspaceId: string, name: string): Promise<WorkspaceRecord>` to `WorkspaceRepositoryPort` interface and `WorkspaceRepository` implementation in `backend/src/db/repositories/workspaceRepository.ts` — executes `UPDATE workspaces SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`

**Checkpoint**: Repository layer ready — user story implementation can begin

---

## Phase 3: User Story 1 — Rename Workspace (Priority: P1) 🎯 MVP

**Goal**: Users can rename a workspace from settings and see the change reflected immediately in the workspace switcher.

**Independent Test**: Open settings → edit workspace name → save → verify name updates in workspace switcher without page reload.

### Tests for User Story 1 (REQUIRED)

- [x] T005 [P] [US1] Write failing integration test for `PATCH /api/v1/workspace/:workspaceId` rename endpoint (success, invalid name, not-found, not-owned) in `backend/tests/integration/workspace-mgmt.test.ts`
- [x] T006 [P] [US1] Write failing test for `workspaceService.rename()` (valid rename, empty name, name too long, not-owned workspace) in `backend/tests/integration/workspace-mgmt.test.ts`

### Implementation for User Story 1

- [x] T007 [US1] Implement `rename(workspaceId, accountId, newName)` method in `backend/src/modules/workspace/services/workspaceService.ts` — validates ownership via `findByIdAndAccountId`, trims and validates name (1-100 chars), calls `updateName`, records `workspace.renamed` audit event with `{ previousName, newName }`
- [x] T008 [US1] Add `PATCH /workspace/:workspaceId` route in `backend/src/app/http/routes/workspaceRoutes.ts` — requires session, validates body with Zod schema `{ name: z.string().min(1).max(100) }`, calls `workspaceService.rename()`, returns updated workspace as JSON 200
- [x] T009 [US1] Add `rename(workspaceId: string, name: string)` method to `workspaceApi` in `frontend/lib/api.ts` — sends `PATCH /api/v1/workspace/:workspaceId` with `{ name }` body, session-authenticated
- [x] T010 [US1] Add `renameWorkspace(workspaceId: string, name: string)` to workspace context in `frontend/lib/workspace-context.tsx` — calls `workspaceApi.rename()`, updates workspace name in local `workspaces` state
- [x] T011 [US1] Add editable workspace name section at top of settings page in `frontend/components/dashboard/settings-view.tsx` — text input pre-filled with current workspace name, save/cancel buttons, inline validation (non-empty, max 100 chars), calls `renameWorkspace` from context on save

**Checkpoint**: Rename flow fully functional end-to-end

---

## Phase 4: User Story 2 — Delete Workspace (Priority: P2)

**Goal**: Users can permanently delete a workspace and all its data from a Danger Zone card in settings, with confirmation requiring them to type the workspace name.

**Independent Test**: Create a second workspace with documents/chats → go to settings → click Delete in Danger Zone → type workspace name → confirm → verify workspace removed and redirected to remaining workspace.

### Tests for User Story 2 (REQUIRED)

- [x] T012 [P] [US2] Write failing integration test for `DELETE /api/v1/workspace/:workspaceId` endpoint (success with cascade, last-workspace rejection, not-found, not-owned) in `backend/tests/integration/workspace-mgmt.test.ts`
- [x] T013 [P] [US2] Write failing test for `workspaceService.delete()` (successful delete, last-workspace guard returns 400, not-owned returns 404) in `backend/tests/integration/workspace-mgmt.test.ts`

### Implementation for User Story 2

- [x] T014 [US2] Implement `delete(workspaceId, accountId)` method in `backend/src/modules/workspace/services/workspaceService.ts` — validates ownership, checks `countByAccountId > 1` (rejects with `badRequest` if last workspace), calls `deleteById`, records `workspace.deleted` audit event with `{ deletedWorkspaceId, deletedWorkspaceName }`
- [x] T015 [US2] Add `DELETE /workspace/:workspaceId` route in `backend/src/app/http/routes/workspaceRoutes.ts` — requires session, calls `workspaceService.delete()`, returns 204 No Content
- [x] T016 [US2] Add `delete(workspaceId: string)` method to `workspaceApi` in `frontend/lib/api.ts` — sends `DELETE /api/v1/workspace/:workspaceId`, session-authenticated
- [x] T017 [US2] Add `deleteWorkspace(workspaceId: string)` to workspace context in `frontend/lib/workspace-context.tsx` — calls `workspaceApi.delete()`, removes workspace from local state, if deleted workspace was active switches to first remaining workspace, clears deleted workspace's token from localStorage
- [x] T018 [US2] Add Danger Zone card at bottom of settings page in `frontend/components/dashboard/settings-view.tsx` — red-accented border card with warning text, "Delete this workspace" button (disabled with tooltip when only one workspace exists), confirmation dialog requiring user to type workspace name to confirm, calls `deleteWorkspace` from context on confirm

**Checkpoint**: Delete flow fully functional end-to-end, including cascading data removal

---

## Phase 5: User Story 3 — Settings Page Layout (Priority: P3)

**Goal**: Settings page is organized with workspace management at top and Danger Zone visually separated at bottom.

**Independent Test**: Open settings → verify workspace name section appears above retrieval settings, Danger Zone card appears at bottom with red accent styling.

### Implementation for User Story 3

- [x] T019 [US3] Verify and adjust layout ordering in `frontend/components/dashboard/settings-view.tsx` — workspace name editor at top, existing retrieval settings in middle, Danger Zone card at bottom with clear visual separation (this may already be correct from T011 and T018 — verify and adjust spacing/ordering if needed)

**Checkpoint**: Settings page layout complete and visually polished

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup

- [x] T020 Run all backend tests to verify no regressions in `backend/tests/`
- [x] T021 Run quickstart.md manual validation — test all 4 scenarios listed in `specs/016-workspace-mgmt/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2
- **User Story 2 (Phase 4)**: Depends on Phase 2 — can run in parallel with US1
- **User Story 3 (Phase 5)**: Depends on US1 (T011) and US2 (T018) since it verifies their layout
- **Polish (Phase 6)**: Depends on all user stories complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational — no dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational — no dependencies on US1 (independent)
- **User Story 3 (P3)**: Depends on US1 and US2 completing their settings-view changes

### Within Each User Story

- Tests MUST be written and FAIL before implementation (TDD)
- Service before routes (routes call service)
- Backend before frontend (frontend calls backend API)
- API client before context (context uses API client)
- Context before UI component (component uses context)

### Parallel Opportunities

- T005 and T006 (US1 tests) can run in parallel
- T012 and T013 (US2 tests) can run in parallel
- US1 and US2 implementation can run in parallel (different methods/endpoints, though they share files — coordinate on `workspaceService.ts`, `workspaceRoutes.ts`, `api.ts`, `workspace-context.tsx`, and `settings-view.tsx`)

---

## Parallel Example: User Story 1

```bash
# Launch US1 tests in parallel:
Task: "T005 - Integration test for PATCH rename endpoint"
Task: "T006 - Service test for workspaceService.rename()"

# Then implement sequentially:
Task: "T007 - Service: rename()"
Task: "T008 - Route: PATCH /workspace/:id"
Task: "T009 - API client: rename()"
Task: "T010 - Context: renameWorkspace()"
Task: "T011 - UI: workspace name editor"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T004)
3. Complete Phase 3: User Story 1 (T005-T011)
4. **STOP and VALIDATE**: Rename works end-to-end
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Repository layer ready
2. Add User Story 1 → Rename works → Deploy (MVP!)
3. Add User Story 2 → Delete works → Deploy
4. Add User Story 3 → Layout verified → Deploy
5. Polish → Final validation

---

## Notes

- No database migration needed — existing schema supports all operations
- `deleteById` already exists in repository — US2 only needs service + route + frontend
- Database CASCADE handles all child data cleanup automatically
- Total task count: 21
- US1: 7 tasks (2 test + 5 impl), US2: 7 tasks (2 test + 5 impl), US3: 1 task, Setup: 2, Foundational: 2, Polish: 2
- Suggested MVP: User Story 1 (Rename) — 11 tasks total including setup/foundational
