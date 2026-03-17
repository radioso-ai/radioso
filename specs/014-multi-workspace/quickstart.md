# Quickstart: Multi-Workspace Support

**Branch**: `014-multi-workspace` | **Date**: 2026-03-17

## Prerequisites

- Node.js backend running with PostgreSQL + pgvector
- Frontend running (Next.js)
- Existing `.env` configured (no new env vars needed)

## Implementation Order

### Phase 1: Database & Repository Layer
1. Write migration `005_multi_workspace.sql` (see data-model.md)
2. Create `WorkspaceRepository` (CRUD: create, findById, listByAccountId, findByIdAndAccountId)
3. Rename `AccountTokenRepository` → `WorkspaceTokenRepository`, update queries to use `workspace_id`
4. Update all workspace-scoped repositories: replace `account_id` with `workspace_id` in queries
   - `documentRepository.ts`
   - `chunkRepository.ts`
   - `conversationRepository.ts`
   - `messageRepository.ts`
   - `retrievalSettingsRepository.ts`
   - `documentProcessingJobRepository.ts`
   - `auditEventRepository.ts` (add `workspace_id`, keep `account_id`)

### Phase 2: Service Layer
5. Create `WorkspaceService` (create workspace, list workspaces, validate ownership)
6. Update `AuthService`:
   - `register()` → also creates default workspace
   - Token methods → accept `workspaceId` instead of `accountId`
   - `authenticateApiToken()` → returns `{ workspaceId, accountId }` instead of `{ accountId }`
7. Update all services: replace `accountId` params with `workspaceId`
   - `DocumentIngestionService`
   - `DocumentDeletionService`
   - `DocumentProcessingService` / `DocumentProcessingWorker`
   - `ChatService` / `ChatHistoryService`
   - `RetrievalSettingsService`
   - `RetrievalPipelineService`
   - `VectorSearch` / `LexicalSearch`

### Phase 3: Transport Layer
8. Update `requireApiToken` middleware: set `res.locals.workspaceId` (and `res.locals.accountId`)
9. Create workspace routes (`GET /api/v1/workspace`, `POST /api/v1/workspace`)
10. Update `accountRoutes` token endpoint → `GET /api/v1/account/workspaces/:workspaceId/token`
11. Update all route handlers: read `workspaceId` from `res.locals` instead of `accountId`

### Phase 4: Frontend
12. Create `WorkspaceProvider` context (active workspace, list, switch, create)
13. Create workspace switcher component (dropdown below logo, above menu)
14. Update `auth-context.tsx` bootstrap to fetch workspaces after login
15. Update `api.ts` — token storage per workspace, `accountApi.getToken(workspaceId)`
16. Update `app-sidebar.tsx` — insert workspace switcher
17. Update `dashboard-shell.tsx` — pass workspaceId through

## Verification

```bash
# Run migration
npm run migrate

# Run backend tests
npm test

# Manual verification:
# 1. Register new account → default workspace created
# 2. Create second workspace via switcher
# 3. Upload document in workspace A
# 4. Switch to workspace B → document list empty
# 5. Generate API token for workspace B
# 6. Use workspace B token via curl → no workspace A data visible
```
