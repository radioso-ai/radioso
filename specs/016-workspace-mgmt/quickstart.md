# Quickstart: Workspace Management (Rename & Delete)

**Feature**: 016-workspace-mgmt | **Date**: 2026-03-18

## Prerequisites

- Node.js and npm installed
- PostgreSQL running with existing schema (migration 005 already applied)
- Backend and frontend dev servers running

## What Changes

### Backend (4 files modified)

1. **`backend/src/db/repositories/workspaceRepository.ts`**
   - Add `updateName(workspaceId, name)` method to interface and implementation

2. **`backend/src/modules/workspace/services/workspaceService.ts`**
   - Add `auditService` dependency injection
   - Add `rename(workspaceId, accountId, newName)` — validates ownership, trims/validates name, updates, records audit event
   - Add `delete(workspaceId, accountId)` — validates ownership, checks not-last-workspace, deletes, records audit event

3. **`backend/src/app/http/routes/workspaceRoutes.ts`**
   - Add `PATCH /workspace/:workspaceId` — rename endpoint
   - Add `DELETE /workspace/:workspaceId` — delete endpoint

4. **`backend/src/app/server/dependencies.ts`**
   - Pass `auditService` into `WorkspaceService` constructor

### Backend (1 file created)

5. **`backend/tests/integration/workspace-mgmt.test.ts`**
   - Integration tests for rename and delete flows

### Frontend (3 files modified)

6. **`frontend/lib/api.ts`**
   - Add `workspaceApi.rename(workspaceId, name)`
   - Add `workspaceApi.delete(workspaceId)`

7. **`frontend/lib/workspace-context.tsx`**
   - Add `renameWorkspace(workspaceId, name)` — calls API, updates local state
   - Add `deleteWorkspace(workspaceId)` — calls API, removes from state, switches active workspace

8. **`frontend/components/dashboard/settings-view.tsx`**
   - Add workspace name editor section at top of settings
   - Add "Danger Zone" card at bottom with delete button and confirmation dialog

## No Migration Needed

The existing database schema already supports all operations:
- Rename: standard UPDATE on `workspaces.name`
- Delete: CASCADE constraints on all child tables handle cleanup automatically

## Testing

```bash
# Run backend tests
cd backend && npm test -- --grep "workspace"

# Manual testing
# 1. Open settings page → verify workspace name is editable
# 2. Rename workspace → verify name updates in switcher
# 3. Create a second workspace → delete the first → verify redirect
# 4. Try deleting last workspace → verify it's blocked
```
