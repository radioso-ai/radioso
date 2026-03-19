# Tasks: Model Token Usage Tracking & Account Summaries

**Input**: Design documents from `/specs/019-token-usage-ledger/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED per constitution (TDD). Tests appear before implementation tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Architecture**: Transport stays in routes/presenters, orchestration stays in chat/retrieval/document services, persistence stays in repositories, and usage capture/summary logic lives in dedicated usage modules.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (`US1`, `US2`, etc.)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create planning-aligned feature skeleton and wire new usage dependencies.

- [x] T001 Create usage feature module directory structure under `backend/src/modules/usage/services/` and repository files under `backend/src/db/repositories/`
- [x] T002 Add the usage migration file in `backend/src/db/migrations/009_usage_tracking.sql`
- [x] T003 Update dependency/container types to include usage services in `backend/src/app/server/types.ts` and `backend/src/app/server/dependencies.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the ledger and summary persistence layer that all user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Tests for Foundational

- [x] T004 Write failing persistence coverage for usage event insert/idempotency and daily rollup upsert in `backend/tests/integration/persistence.integration.test.ts`
- [x] T005 Write failing in-memory/fake repository support for usage events and daily summaries in `backend/tests/support/fakes.ts`

### Implementation for Foundational

- [x] T006 Implement `usage_events` and `account_daily_usage_summaries` schema in `backend/src/db/migrations/009_usage_tracking.sql`
- [x] T007 Implement `UsageEventRepository` with transactional insert-and-rollup behavior in `backend/src/db/repositories/usageEventRepository.ts`
- [x] T008 Implement `AccountDailyUsageSummaryRepository` summary queries in `backend/src/db/repositories/accountDailyUsageSummaryRepository.ts`
- [x] T009 Add usage capture and usage summary service interfaces/implementations in `backend/src/modules/usage/services/usageCaptureService.ts` and `backend/src/modules/usage/services/usageSummaryService.ts`
- [x] T010 Extend `backend/tests/support/testApp.ts` and `backend/tests/support/fakes.ts` to wire in-memory usage repositories and services

**Checkpoint**: Ledger and rollup foundation is working and testable.

---

## Phase 3: User Story 1 — Inspect Token Usage Per Chat Turn (Priority: P1) 🎯 MVP

**Goal**: Operators can open chat history and see attributable token totals plus per-operation breakdowns for assistant turns.

**Independent Test**: Complete a chat turn, open history, and verify the assistant debug section shows turn totals and usage breakdown rows.

### Tests for User Story 1 (REQUIRED)

- [x] T011 [P] [US1] Write failing contract assertions for usage fields in chat history responses in `backend/tests/contract/chat.contract.test.ts`
- [x] T012 [P] [US1] Write failing integration tests for per-turn usage recording in chat success and failure flows in `backend/tests/integration/chat.integration.test.ts`
- [x] T013 [P] [US1] Write failing unit coverage for usage normalization/capture behavior in `backend/tests/unit/usage-capture.service.test.ts`

### Implementation for User Story 1

- [x] T014 [US1] Extend OpenAI-backed gateways to surface provider usage metadata in `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/queryRewriteService.ts`, `backend/src/modules/retrieval/services/rerankService.ts`, and `backend/src/modules/retrieval/services/embeddingService.ts`
- [x] T015 [US1] Thread usage capture through retrieval and chat orchestration in `backend/src/modules/chat/services/chatService.ts` and provider-facing retrieval services under `backend/src/modules/retrieval/services/`
- [x] T016 [US1] Add usage lookup and turn aggregation to `backend/src/modules/chat/services/chatHistoryService.ts`
- [x] T017 [US1] Extend chat history response types in `backend/src/modules/chat/services/chatHistoryService.ts` and `frontend/lib/api.ts`
- [x] T018 [US1] Render usage totals and operation breakdowns in `frontend/components/dashboard/chat-history-view.tsx`

**Checkpoint**: Turn-level usage is visible end to end in history debug.

---

## Phase 4: User Story 2 — Review Account Usage from the Account Menu (Priority: P2)

**Goal**: Account owners can open Usage from the account menu and review current-day, daily, and monthly account-wide totals.

**Independent Test**: Generate usage in multiple workspaces, open Usage from the account menu, and verify aggregated totals appear.

### Tests for User Story 2 (REQUIRED)

- [x] T019 [P] [US2] Write failing contract coverage for `GET /api/v1/account/usage` in `backend/tests/contract/account-usage.contract.test.ts`
- [x] T020 [P] [US2] Write failing integration coverage for account-wide summary aggregation in `backend/tests/integration/account-usage.integration.test.ts`

### Implementation for User Story 2

- [x] T021 [US2] Add account usage query endpoint to `backend/src/app/http/routes/accountRoutes.ts`
- [x] T022 [US2] Implement daily/monthly summary queries and today/current-month totals in `backend/src/modules/usage/services/usageSummaryService.ts`
- [x] T023 [US2] Add account usage client types and request helper to `frontend/lib/api.ts`
- [x] T024 [US2] Add `usage` route parsing/building support in `frontend/lib/dashboard-routes.ts` and existing account dashboard page routing in `frontend/app/account/[accountId]/[[...segments]]/page.tsx`
- [x] T025 [US2] Add Usage screen rendering in `frontend/components/dashboard/usage-view.tsx` and wire it into `frontend/components/dashboard/dashboard-shell.tsx`
- [x] T026 [US2] Add Usage entry to the bottom-left account menu in `frontend/components/dashboard/app-sidebar.tsx`

**Checkpoint**: Account usage screen is reachable and correctly aggregated across workspaces.

---

## Phase 5: User Story 3 — Reach Usage from Any Workspace Context (Priority: P3)

**Goal**: Usage navigation is account-wide but accessible from every workspace without losing the active workspace context.

**Independent Test**: Switch workspaces, open Usage from the account menu, then return to workspace views and verify the active workspace is unchanged.

### Tests for User Story 3

- [ ] T027 [US3] Add failing frontend/API integration expectations for `usage` route preservation semantics in `frontend/lib/dashboard-routes.ts` and `frontend/lib/workspace-context.tsx`

### Implementation for User Story 3

- [x] T028 [US3] Preserve active workspace when navigating to and from the `usage` section in `frontend/components/dashboard/dashboard-shell.tsx` and `frontend/components/dashboard/app-sidebar.tsx`
- [x] T029 [US3] Verify Usage screen remains account-scoped regardless of active workspace in `frontend/components/dashboard/usage-view.tsx`

**Checkpoint**: Usage navigation coexists cleanly with workspace context.

---

## Phase 6: User Story 4 — Trust Usage Totals as Activity Grows (Priority: P4)

**Goal**: Usage totals remain accurate through async document processing, unavailable usage payloads, retries, and reconciliation.

**Independent Test**: Generate async document-processing activity, simulate missing usage data and duplicate operation keys, and verify summaries remain accurate and rebuildable.

### Tests for User Story 4 (REQUIRED)

- [x] T030 [P] [US4] Write failing integration tests for document-processing usage capture and duplicate-operation protection in `backend/tests/integration/account-usage.integration.test.ts`
- [x] T031 [P] [US4] Write failing unit tests for daily summary reconciliation in `backend/tests/unit/usage-summary.service.test.ts`

### Implementation for User Story 4

- [x] T032 [US4] Capture document-processing embedding usage in `backend/src/modules/documents/services/documentProcessingService.ts`
- [x] T033 [US4] Add reconciliation support and unavailable-usage handling in `backend/src/modules/usage/services/usageSummaryService.ts`
- [x] T034 [US4] Expose unavailable-usage indicators consistently in `backend/src/modules/chat/services/chatHistoryService.ts` and `frontend/components/dashboard/chat-history-view.tsx`

**Checkpoint**: Accuracy edge cases are covered and reconciliation path exists.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, docs sync, and cleanup.

- [x] T035 Update shared OpenAPI documentation with usage endpoint/history usage fields in `backend/openapi.yaml`
- [x] T036 Run focused backend validation in `backend/tests/contract/`, `backend/tests/integration/`, and `backend/tests/unit/`
- [x] T037 Run frontend build/type validation in `frontend/`
- [x] T038 Mark completed tasks and refresh quickstart verification notes in `specs/019-token-usage-ledger/tasks.md` and `specs/019-token-usage-ledger/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Phase 1 and blocks all user stories.
- **US1 (Phase 3)**: Depends on Phase 2.
- **US2 (Phase 4)**: Depends on Phase 2; can proceed after foundation is ready.
- **US3 (Phase 5)**: Depends on US2 route/navigation work.
- **US4 (Phase 6)**: Depends on foundation and reuses US1/US2 infrastructure.
- **Polish (Phase 7)**: Depends on all user stories completing.

### User Story Dependencies

- **US1** is the MVP and can ship once foundation is complete.
- **US2** depends on the same usage repositories/services as US1 but is otherwise independent.
- **US3** depends on the `usage` route and account-menu entry from US2.
- **US4** depends on the usage capture/summary infrastructure from US1/US2.

### Within Each User Story

- Tests must fail before implementation.
- Repository/service changes precede routes.
- Backend payload changes precede frontend rendering.
- Navigation updates precede UI-polish verification.

## Parallel Opportunities

- T011, T012, and T013 can run in parallel.
- T019 and T020 can run in parallel.
- T030 and T031 can run in parallel.
- Backend route/service work and frontend UI work can overlap once payload contracts stabilize, but tasks touching the same files must stay sequential.

## Implementation Strategy

### MVP First

1. Complete Setup + Foundational.
2. Deliver US1 end to end.
3. Validate chat history usage before moving on.

### Incremental Delivery

1. Foundation: ledger + summaries + DI.
2. US1: per-turn usage capture/debug.
3. US2/US3: account usage endpoint + account-menu UI.
4. US4: async processing capture, unavailable states, reconciliation.
5. Polish: contract/openapi sync and validation.

## Notes

- No historical backfill in the initial release.
- Monthly totals are derived from daily summaries by design.
- Workspace-scoped API tokens remain limited to workspace resources; only session-authenticated account routes can see account-wide usage.
