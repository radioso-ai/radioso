# Tasks: Multi-Workspace Support

**Input**: Design documents from `/specs/014-multi-workspace/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED per constitution (TDD). Tests MUST be written and fail before implementation.

**Organization**: Tasks grouped by user story. US1 (create/switch workspaces), US2 (per-workspace API token), US3 (data isolation) are all P1 and tightly coupled — they form the MVP together. US4 (default workspace on registration) and US5 (existing account migration) are P2.

**Architecture**: New modules `WorkspaceRepository`, `WorkspaceTokenRepository`, `WorkspaceService` as defined in plan.md. `authService.ts` stays auth-only. `requireApiToken.ts` stays thin.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Web app**: `backend/src/`, `frontend/`

---

## Phase 1: Setup

**Purpose**: Database migration and new module scaffolding

- [ ] T001 Write migration `backend/src/db/migrations/005_multi_workspace.sql` — create `workspaces` table, create `workspace_tokens` table (replaces `account_tokens`), add `workspace_id` column to `documents`, `chunks`, `conversations`, `messages`, `retrieval_settings`, `document_processing_jobs`, `audit_events`. Create default workspace per existing account, backfill `workspace_id` from account ownership, drop old `account_id` columns from workspace-scoped tables, drop `account_tokens` table. See data-model.md for full schema.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: New repository and service modules that all user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

- [ ] T002 [P] Write unit tests for `WorkspaceRepository` in `backend/src/db/repositories/__tests__/workspaceRepository.test.ts` — test create, findById, listByAccountId, findByIdAndAccountId
- [ ] T003 [P] Write unit tests for `WorkspaceTokenRepository` in `backend/src/db/repositories/__tests__/workspaceTokenRepository.test.ts` — test save, findByWorkspaceId, findByTokenHash, touch
- [ ] T004 [P] Write unit tests for `WorkspaceService` in `backend/src/modules/workspace/services/__tests__/workspaceService.test.ts` — test createWorkspace, createDefaultForAccount, listForAccount, validateOwnership, preventDeleteLast

### Implementation for Foundational

- [ ] T005 [P] Create `WorkspaceRepository` in `backend/src/db/repositories/workspaceRepository.ts` — CRUD operations: create(accountId, name), findById(id), listByAccountId(accountId), findByIdAndAccountId(workspaceId, accountId)
- [ ] T006 [P] Create `WorkspaceTokenRepository` in `backend/src/db/repositories/workspaceTokenRepository.ts` — replaces `AccountTokenRepository`. Methods: save(workspaceId, accountId, tokenPrefix, tokenHash, encryptedToken), findByWorkspaceId(workspaceId), findByTokenHash(tokenHash), findByAccountId(accountId), touch(workspaceId, lastUsedAt)
- [ ] T007 Create `WorkspaceService` in `backend/src/modules/workspace/services/workspaceService.ts` — create(accountId, name), createDefaultForAccount(accountId), listForAccount(accountId), validateOwnership(workspaceId, accountId), delete(workspaceId, accountId) with last-workspace guard
- [ ] T008 Remove `backend/src/db/repositories/accountTokenRepository.ts` and update all imports to use `WorkspaceTokenRepository`
- [ ] T009 Update `AppDependencies` in `backend/src/app/server/types.ts` — add `workspaceService: WorkspaceService`
- [ ] T010 Update `buildDependencies` in `backend/src/app/server/dependencies.ts` — wire `WorkspaceRepository`, `WorkspaceTokenRepository`, `WorkspaceService`

**Checkpoint**: Foundation ready — new workspace entity and token model available for all stories

---

## Phase 3: User Story 1 — Create and Switch Workspaces (Priority: P1)

**Goal**: Users can create workspaces and switch between them in the sidebar

**Independent Test**: Create a second workspace, verify it appears in the list, switch to it

### Tests for User Story 1

- [ ] T011 [P] [US1] Write integration test for workspace CRUD routes in `backend/src/app/http/routes/__tests__/workspaceRoutes.test.ts` — test GET /api/v1/workspace returns list, POST /api/v1/workspace creates workspace, requires session auth
- [ ] T012 [P] [US1] Write unit test for `AuthService.register` creating default workspace in `backend/src/modules/auth/services/__tests__/authService.test.ts` — verify register() calls workspaceService.createDefaultForAccount

### Implementation for User Story 1

- [ ] T013 [US1] Create workspace routes in `backend/src/app/http/routes/workspaceRoutes.ts` — GET / (list workspaces, requireSession), POST / (create workspace, requireSession with name validation via Zod)
- [ ] T014 [US1] Mount workspace routes in `backend/src/app/http/routes/index.ts` — add `router.use("/api/v1/workspace", createWorkspaceRoutes(dependencies))`
- [ ] T015 [US1] Update `AuthService.register` in `backend/src/modules/auth/services/authService.ts` — after account creation, call `workspaceService.createDefaultForAccount(account.id)`. Add `workspaceService` to `AuthServiceDependencies`.
- [ ] T016 [P] [US1] Add workspace API methods to `frontend/lib/api.ts` — `workspaceApi.list(): WorkspaceSummary[]`, `workspaceApi.create(name): WorkspaceSummary`
- [ ] T017 [US1] Create `WorkspaceProvider` in `frontend/lib/workspace-context.tsx` — holds active workspace, workspace list, switchWorkspace(id), createWorkspace(name). Stores active workspace ID in localStorage as `radioso.activeWorkspaceId`. Fetches workspace list on mount.
- [ ] T018 [US1] Create workspace switcher component in `frontend/components/dashboard/workspace-switcher.tsx` — dropdown showing workspace name, list of workspaces, "Create workspace" action. Uses `useWorkspace()` hook from context.
- [ ] T019 [US1] Insert workspace switcher into sidebar in `frontend/components/dashboard/app-sidebar.tsx` — add `<WorkspaceSwitcher />` between `<SidebarHeader>` (logo) and `<SidebarContent>` (menu)
- [ ] T020 [US1] Wrap dashboard with `WorkspaceProvider` in `frontend/app/account/[accountId]/[[...segments]]/page.tsx` — wrap `<DashboardShell>` with `<WorkspaceProvider accountId={user.userId}>`

**Checkpoint**: Users can create workspaces and switch between them in the UI

---

## Phase 4: User Story 2 — Per-Workspace API Token (Priority: P1)

**Goal**: Each workspace has its own API token. The token identifies the workspace on API calls.

**Independent Test**: Generate tokens for two workspaces, use each to list documents, confirm isolation

### Tests for User Story 2

- [ ] T021 [P] [US2] Write unit tests for updated `AuthService` token methods in `backend/src/modules/auth/services/__tests__/authService.test.ts` — test getTokenForWorkspace(workspaceId, accountId), authenticateApiToken returns { workspaceId, accountId }
- [ ] T022 [P] [US2] Write integration test for workspace token route in `backend/src/app/http/routes/__tests__/accountRoutes.test.ts` — test GET /api/v1/account/workspaces/:workspaceId/token returns token, validates ownership

### Implementation for User Story 2

- [ ] T023 [US2] Update `AuthService` token methods in `backend/src/modules/auth/services/authService.ts` — `getTokenForWorkspace(workspaceId, accountId)` replaces `getAccountTokenForAccount`. `authenticateApiToken` now returns `{ workspaceId, accountId }` by joining workspace_tokens → workspaces. Update `AccountTokenRepositoryPort` → `WorkspaceTokenRepositoryPort`.
- [ ] T024 [US2] Update account routes token endpoint in `backend/src/app/http/routes/accountRoutes.ts` — change `GET /token` to `GET /workspaces/:workspaceId/token`. Extract workspaceId from params, accountId from session. Call `authService.getTokenForWorkspace(workspaceId, accountId)`.
- [ ] T025 [US2] Update `requireApiToken` middleware in `backend/src/app/http/middleware/requireApiToken.ts` — `authenticateApiToken` now returns `{ workspaceId, accountId }`. Set both `res.locals.workspaceId` and `res.locals.accountId`.
- [ ] T026 [US2] Update frontend token storage in `frontend/lib/api.ts` — change storage key from `radioso.apiToken` to `radioso.apiToken.{workspaceId}`. Update `accountApi.getToken(workspaceId)` to call `/account/workspaces/${workspaceId}/token`. Update `getStoredApiToken` to accept workspaceId.
- [ ] T027 [US2] Update `auth-context.tsx` bootstrap in `frontend/lib/auth-context.tsx` — after login, fetch workspace list, select active workspace (from localStorage or default), then fetch token for that workspace
- [ ] T028 [US2] Update `token-view.tsx` in `frontend/components/dashboard/token-view.tsx` — show which workspace the token belongs to, use workspace-scoped token fetch
- [ ] T029 [US2] Wire workspace token fetch on workspace switch in `frontend/lib/workspace-context.tsx` — when user switches workspace, fetch/cache the API token for the new workspace, update stored token

**Checkpoint**: API tokens are per-workspace, middleware resolves workspaceId from token

---

## Phase 5: User Story 3 — Workspace-Scoped Data Isolation (Priority: P1)

**Goal**: Documents, conversations, settings, search results are all scoped to the active workspace

**Independent Test**: Upload document in workspace A, switch to workspace B, verify document list is empty and search returns nothing

### Tests for User Story 3

- [ ] T030 [P] [US3] Write integration tests for workspace-scoped document routes in `backend/src/app/http/routes/__tests__/documentRoutes.test.ts` — two workspace tokens, documents created under one are invisible to the other
- [ ] T031 [P] [US3] Write integration tests for workspace-scoped chat routes in `backend/src/app/http/routes/__tests__/chatRoutes.test.ts` — conversations scoped to workspace
- [ ] T032 [P] [US3] Write integration tests for workspace-scoped settings routes in `backend/src/app/http/routes/__tests__/settingsRoutes.test.ts` — settings independent per workspace

### Implementation for User Story 3

- [ ] T033 [P] [US3] Update `DocumentRepository` in `backend/src/db/repositories/documentRepository.ts` — replace all `account_id` references with `workspace_id` in queries and method signatures
- [ ] T034 [P] [US3] Update `ChunkRepository` in `backend/src/db/repositories/chunkRepository.ts` — replace `account_id` with `workspace_id`
- [ ] T035 [P] [US3] Update `ConversationRepository` in `backend/src/db/repositories/conversationRepository.ts` — replace `account_id` with `workspace_id`
- [ ] T036 [P] [US3] Update `MessageRepository` in `backend/src/db/repositories/messageRepository.ts` — replace `account_id` with `workspace_id`
- [ ] T037 [P] [US3] Update `RetrievalSettingsRepository` in `backend/src/db/repositories/retrievalSettingsRepository.ts` — replace `account_id` PK with `workspace_id`
- [ ] T038 [P] [US3] Update `DocumentProcessingJobRepository` in `backend/src/db/repositories/documentProcessingJobRepository.ts` — replace `account_id` with `workspace_id`
- [ ] T039 [P] [US3] Update `AuditEventRepository` in `backend/src/db/repositories/auditEventRepository.ts` — add `workspace_id` parameter, keep `account_id` for account-level events
- [ ] T040 [P] [US3] Update `VectorSearch` in `backend/src/modules/retrieval/infra/vectorSearch.ts` — filter by `workspace_id` instead of `account_id`
- [ ] T041 [P] [US3] Update `LexicalSearch` in `backend/src/modules/retrieval/infra/lexicalSearch.ts` — filter by `workspace_id` instead of `account_id`
- [ ] T042 [US3] Update `DocumentIngestionService` in `backend/src/modules/documents/services/documentIngestionService.ts` — replace `accountId` param with `workspaceId`
- [ ] T043 [US3] Update `DocumentDeletionService` in `backend/src/modules/documents/services/documentDeletionService.ts` — replace `accountId` param with `workspaceId`
- [ ] T044 [US3] Update `DocumentProcessingService` and `DocumentProcessingWorker` in `backend/src/modules/documents/services/documentProcessingService.ts` and `backend/src/modules/documents/services/documentProcessingWorker.ts` — use `workspaceId` from job record
- [ ] T045 [US3] Update `ChatService` in `backend/src/modules/chat/services/chatService.ts` — replace `accountId` param with `workspaceId`
- [ ] T046 [US3] Update `ChatHistoryService` in `backend/src/modules/chat/services/chatHistoryService.ts` — replace `accountId` param with `workspaceId`
- [ ] T047 [US3] Update `RetrievalSettingsService` in `backend/src/modules/settings/services/retrievalSettingsService.ts` — replace `accountId` with `workspaceId`
- [ ] T048 [US3] Update `RetrievalPipelineService` in `backend/src/modules/retrieval/services/retrievalPipelineService.ts` — replace `accountId` with `workspaceId`
- [ ] T049 [US3] Update `AuditService` in `backend/src/modules/audit/services/auditService.ts` — add optional `workspaceId` to `AuditEventInput`
- [ ] T050 [US3] Update all route handlers to use `workspaceId` from `res.locals` — `backend/src/app/http/routes/documentRoutes.ts`, `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`

**Checkpoint**: All data is fully scoped to workspace. Two workspaces under one account have completely isolated data.

---

## Phase 6: User Story 4 — Default Workspace on Account Creation (Priority: P2)

**Goal**: New users get a default workspace automatically on registration. Seamless onboarding.

**Independent Test**: Register a new account, verify a default workspace exists and the user lands in it

### Tests for User Story 4

- [ ] T051 [US4] Write integration test for registration flow in `backend/src/app/http/routes/__tests__/authRoutes.test.ts` — register new account, verify workspace list has one entry

### Implementation for User Story 4

- [ ] T052 [US4] Verify `AuthService.register` (from T015) creates default workspace — this should already be done in Phase 3. Add additional test coverage for the full registration → workspace → token bootstrap flow if needed.
- [ ] T053 [US4] Update frontend login flow in `frontend/lib/auth-context.tsx` — after login/register, fetch workspaces, auto-select the single workspace, fetch its token

**Checkpoint**: New registration creates account + default workspace + user lands in it

---

## Phase 7: User Story 5 — Existing Account Migration (Priority: P2)

**Goal**: Existing accounts get all their data assigned to a default workspace via migration

**Independent Test**: Run migration on database with existing data, verify all records have workspace_id set

### Tests for User Story 5

- [ ] T054 [US5] Write migration test in `backend/src/db/__tests__/migration005.test.ts` — seed database with accounts, documents, conversations, settings; run migration; verify default workspaces created and all workspace_id columns populated

### Implementation for User Story 5

- [ ] T055 [US5] Verify migration `005_multi_workspace.sql` (from T001) handles existing data correctly — create default workspace per existing account, backfill all workspace_id columns, handle edge cases (accounts with no data, accounts with tokens)

**Checkpoint**: Existing accounts see all their data in a default workspace after migration

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, error handling, and cleanup

- [ ] T056 [P] Add workspace name validation (non-empty, max 100 chars) in `WorkspaceService` and Zod schema in workspace routes
- [ ] T057 [P] Add error handling for workspace-not-found and workspace-not-owned scenarios — return 404/403 with clear messages
- [ ] T058 [P] Update `frontend/components/dashboard/chat-history-view.tsx` — replace any `accountId` references with workspace context
- [ ] T059 Run full quickstart.md verification scenario end-to-end
- [ ] T060 Clean up any remaining `accountId` references in workspace-scoped code paths (grep for `accountId` in services/repositories/routes that should now use `workspaceId`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 (migration must exist for repository tests)
- **Phase 3 (US1)**: Depends on Phase 2 — workspace entity and service available
- **Phase 4 (US2)**: Depends on Phase 2 — workspace token repository available
- **Phase 5 (US3)**: Depends on Phase 4 — middleware must resolve workspaceId before routes can use it
- **Phase 6 (US4)**: Depends on Phase 3 (registration creates workspace) + Phase 4 (token flow)
- **Phase 7 (US5)**: Depends on Phase 1 (migration) — can be tested independently
- **Phase 8 (Polish)**: Depends on Phases 3-7

### User Story Dependencies

- **US1 (Create/Switch)**: After Phase 2. Independent.
- **US2 (Per-Workspace Token)**: After Phase 2. Independent of US1 on backend, but frontend needs workspace context from US1.
- **US3 (Data Isolation)**: After US2 (needs middleware to resolve workspaceId from token).
- **US4 (Default on Registration)**: After US1 + US2 (needs workspace creation + token flow).
- **US5 (Migration)**: After Phase 1 only — can be validated independently from code changes.

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Repositories before services
- Services before routes
- Backend before frontend (within each story)

### Parallel Opportunities

- T002, T003, T004 (foundational tests) — all parallel
- T005, T006 (new repositories) — parallel
- T011, T012 (US1 tests) — parallel
- T021, T022 (US2 tests) — parallel
- T030, T031, T032 (US3 tests) — parallel
- T033–T041 (US3 repository updates) — all parallel (different files)
- T016 (frontend API) can run parallel with backend US1 tasks

---

## Parallel Example: Phase 5 (US3) Repository Updates

```bash
# All repository updates touch different files — run in parallel:
T033: Update DocumentRepository (documentRepository.ts)
T034: Update ChunkRepository (chunkRepository.ts)
T035: Update ConversationRepository (conversationRepository.ts)
T036: Update MessageRepository (messageRepository.ts)
T037: Update RetrievalSettingsRepository (retrievalSettingsRepository.ts)
T038: Update DocumentProcessingJobRepository (documentProcessingJobRepository.ts)
T039: Update AuditEventRepository (auditEventRepository.ts)
T040: Update VectorSearch (vectorSearch.ts)
T041: Update LexicalSearch (lexicalSearch.ts)
```

---

## Implementation Strategy

### MVP (Phase 1 + 2 + 3 + 4 + 5)

All three P1 stories are tightly coupled and form the minimum viable feature:
1. Phase 1: Migration
2. Phase 2: New modules (WorkspaceRepository, WorkspaceTokenRepository, WorkspaceService)
3. Phase 3: Create/switch workspaces (US1)
4. Phase 4: Per-workspace API tokens (US2)
5. Phase 5: Data isolation (US3)
6. **STOP and VALIDATE**: Full workspace isolation working end-to-end

### Incremental Delivery

1. MVP (above) → core feature working
2. Phase 6 (US4) → new user onboarding smooth
3. Phase 7 (US5) → existing accounts migrated safely
4. Phase 8 → polish and edge cases

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- The three P1 stories (US1, US2, US3) are tightly coupled and form the MVP together
- P2 stories (US4, US5) are independently valuable increments
- Total: 60 tasks across 8 phases
- Key risk: migration correctness (T001/T055) — test thoroughly with real-shaped data
