# Tasks: Document Search

**Input**: Design documents from `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED and must be written before implementation. Frontend verification follows the approved spec and quickstart.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm scope, target files, and current document/retrieval/history seams before additive search work begins.

- [ ] T001 Review `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/spec.md`, `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/plan.md`, and current document/retrieval/history files under `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/`, `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/retrieval/`, and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/`
- [ ] T002 [P] Inventory existing document HTTP contract touchpoints in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/http/openapi/document.ts`, `/Users/dm/conductor/workspaces/radioso/document-search/frontend/lib/api.ts`, and `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/contract/document.contract.test.ts`
- [ ] T003 [P] Inventory current audit replay and shared trace touchpoints in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/db/repositories/auditEventRepository.ts`, `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/chat/services/chatHistoryService.ts`, `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/retrieval/services/retrievalTraceAssembler.ts`, and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/chat-retrieval-trace-graph.tsx`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared search orchestration, snapshot persistence, and contract seams that all user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Write failing backend unit coverage for document-search result aggregation and snapshot semantics in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search.test.ts`
- [ ] T005 [P] Write failing backend unit coverage for document-search replay and unavailable-action handling in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search-history.test.ts`
- [ ] T006 [P] Extend audit-event repository support for `document.search` create/list/get operations in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/db/repositories/auditEventRepository.ts`
- [ ] T007 [P] Create focused document-search domain and service types in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchService.ts`
- [ ] T008 [P] Create focused document-search history/replay service in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchHistoryService.ts`
- [ ] T009 [P] Create shared search snapshot and result presenters in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchPresenter.ts`
- [ ] T010 Create search-specific retrieval trace assembly helpers that emit the shared `RetrievalTrace` contract in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/retrieval/services/documentSearchTraceAssembler.ts`
- [ ] T011 Add additive document-search schemas and route registrations to `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/http/openapi/document.ts`
- [ ] T012 Regenerate generated OpenAPI artifacts from `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/http/openapi/document.ts` into `/Users/dm/conductor/workspaces/radioso/document-search/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/document-search/backend/openapi.json`
- [ ] T013 Extract dashboard document-search state and result rendering seams from `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx` into `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-bar.tsx`, `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-results.tsx`, and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/use-document-search.ts`

**Checkpoint**: Shared search, replay, trace, and frontend extraction seams are in place.

---

## Phase 3: User Story 1 - Search Documents Headlessly (Priority: P1) 🎯 MVP

**Goal**: Expose a dedicated live document-search API that returns ranked document results with bounded explanation fields while preserving plain browsing at `GET /document/`.

**Independent Test**: Execute a live document search request with and without filters and confirm the response returns a stable `searchId`, ranked document results, explanation fields, and explicit no-results behavior distinct from browse.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T014 [P] [US1] Write failing backend contract coverage for live document search in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/contract/document.contract.test.ts`
- [ ] T015 [P] [US1] Write failing backend integration coverage for ranked live document search and no-results responses in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/integration/persistence.integration.test.ts`
- [ ] T016 [P] [US1] Write failing backend unit coverage for filter handling and document deduplication in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search.test.ts`

### Implementation for User Story 1

- [ ] T017 [US1] Implement live search orchestration with chunk-to-document aggregation in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchService.ts`
- [ ] T018 [US1] Extend `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/retrieval/services/candidateRetrievalStage.ts` and related retrieval helpers so document search can reuse retrieval signals without routing through chat-only orchestration
- [ ] T019 [US1] Add live document-search routes and request validation in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/http/routes/documentRoutes.ts`
- [ ] T020 [US1] Wire live search dependencies in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/server/dependencies.ts` and `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/server/types.ts`
- [ ] T021 [US1] Add frontend document-search request/response types and client methods in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/lib/api.ts`

**Checkpoint**: User Story 1 is independently functional and delivers the headless search MVP.

---

## Phase 4: User Story 2 - Review Search Diagnostics Historically (Priority: P1)

**Goal**: Persist each completed search as a replayable snapshot with shared retrieval diagnostics, and expose list/replay APIs for historical inspection.

**Independent Test**: Execute a document search, confirm it is listed in history, reopen it by `searchId`, and verify the stored snapshot and shared `RetrievalTrace` are returned without rerunning retrieval.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T022 [P] [US2] Write failing backend contract coverage for search history list and replay endpoints in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/contract/document.contract.test.ts`
- [ ] T023 [P] [US2] Write failing backend unit coverage for shared trace reuse and snapshot replay behavior in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search-history.test.ts`
- [ ] T024 [P] [US2] Write failing backend integration coverage for persisted search replay after underlying document changes in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 2

- [ ] T025 [US2] Persist bounded search snapshots and `document.search` audit events in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchService.ts`
- [ ] T026 [US2] Implement history list and replay reads in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchHistoryService.ts`
- [ ] T027 [US2] Emit shared `RetrievalTrace` payloads for document search in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/retrieval/services/documentSearchTraceAssembler.ts` and `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [ ] T028 [US2] Add history list and replay routes to `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/http/routes/documentRoutes.ts`
- [ ] T029 [US2] Extend frontend API types and methods for search history listing and replay in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/lib/api.ts`
- [ ] T030 [US2] Reuse the shared trace graph/detail components for document-search diagnostics in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/chat-retrieval-trace-graph.tsx`, `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/chat-retrieval-trace-detail.tsx`, and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-history.tsx`

**Checkpoint**: User Stories 1 and 2 are independently functional and historical search replay works through the audit path.

---

## Phase 5: User Story 3 - Reuse Search Runs As A Knowledge Workflow (Priority: P2)

**Goal**: Make search replay and ranked results actionable through the guaranteed v1 actions without adding direct search-to-chat coupling.

**Independent Test**: Open a live or replayed search result and confirm the UI and API expose open document, inspect evidence, open diagnostics/history, and rerun-as-new-search actions, with explicit unavailable states when documents have changed.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T031 [P] [US3] Write failing backend contract coverage for replay mode markers and guaranteed result actions in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/contract/document.contract.test.ts`
- [ ] T032 [P] [US3] Write failing backend unit coverage for replay-vs-live distinction and unavailable downstream action states in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search-history.test.ts`

### Implementation for User Story 3

- [ ] T033 [US3] Add replay-mode markers and guaranteed v1 action shaping in `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/modules/documents/services/documentSearchPresenter.ts`
- [ ] T034 [US3] Add visible result actions and evidence inspection UI in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-results.tsx`
- [ ] T035 [US3] Add historical search list/reopen UI and rerun-as-new-search behavior in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-history.tsx` and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/use-document-search.ts`
- [ ] T036 [US3] Add safe unavailable-state handling for stale replayed document actions in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-results.tsx` and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx`

**Checkpoint**: User Stories 1, 2, and 3 are independently functional and search runs behave like reusable workflow artifacts.

---

## Phase 6: User Story 4 - Search From The Documents Top Bar (Priority: P3)

**Goal**: Surface the same document-search capability in the Documents page without regressing existing browse, CRUD, import, and pagination flows.

**Independent Test**: Run a search from the Documents top bar, verify ranked results and explicit states render in place, then clear the query and confirm the ordinary document list returns intact.

### Tests for User Story 4 (REQUIRED for backend)

- [ ] T037 [P] [US4] Write failing frontend component/state verification for documents top-bar search flows in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx`

### Implementation for User Story 4

- [ ] T038 [US4] Integrate the extracted search bar, results, and history components into `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx`
- [ ] T039 [US4] Preserve plain browse pagination, CRUD dialogs, and document selection while search state is inactive in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx`
- [ ] T040 [US4] Add explicit loading, failure, no-results, and clear-search state treatment in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-bar.tsx`, `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-results.tsx`, and `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx`

**Checkpoint**: All user stories are independently functional and the dashboard surface preserves browse semantics while adding search.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, contract regeneration, and scope-fit verification across all stories.

- [ ] T041 [P] Refresh implementation notes in `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/quickstart.md` and `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/contracts/document-search-contract.md` if implementation details drift
- [ ] T042 Run affected backend unit, contract, and integration suites in `/Users/dm/conductor/workspaces/radioso/document-search/backend/tests/`
- [ ] T043 [P] Regenerate and verify `/Users/dm/conductor/workspaces/radioso/document-search/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/document-search/backend/openapi.json` against `/Users/dm/conductor/workspaces/radioso/document-search/backend/src/app/http/openapi/document.ts`
- [ ] T044 [P] Run targeted frontend verification for document-search live results, history replay, diagnostics, and browse fallback in `/Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/`
- [ ] T045 Re-read `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/spec.md`, `/Users/dm/conductor/workspaces/radioso/document-search/specs/026-document-search/plan.md`, and changed code to verify scope fit before implementation review handoff

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion and is the suggested MVP slice
- **User Story 2 (Phase 4)**: Depends on User Story 1 because replay persists completed live searches and reuses the live search contract
- **User Story 3 (Phase 5)**: Depends on User Story 2 because guaranteed actions rely on replay/history semantics and persisted result shaping
- **User Story 4 (Phase 6)**: Depends on Foundational and can begin after the search client contract stabilizes, but is safest after US1-US3 backend contracts are in place
- **Polish (Phase 7)**: Depends on all desired story work being complete

### User Story Dependencies

- **US1**: Independent after Foundational and is the recommended MVP
- **US2**: Depends on the live search contract and persisted search snapshots from US1
- **US3**: Depends on persisted replay and diagnostics from US2
- **US4**: Depends on the search client contract and frontend extraction work from Phase 2, but remains independently testable once wired

### Within Each User Story

- Backend tests must be written and fail before implementation
- Search/history service extractions must land before `documentRoutes.ts` grows new behavior
- Shared trace helpers must land before history replay consumers
- The OpenAPI registry must be updated before generated artifact refresh and contract verification
- Frontend extraction tasks must land before `documents-view.tsx` is wired to live search, replay, and diagnostics
- Existing responsibility-limited files must stay transport-only or presentation-only

### Parallel Opportunities

- T002 and T003 can run in parallel
- T005-T009 can run in parallel after T004 establishes failing baseline coverage
- T014-T016 can run in parallel
- T022-T024 can run in parallel
- T031 and T032 can run in parallel
- T041, T043, and T044 can run in parallel after implementation stabilizes

---

## Parallel Example: User Story 1

```bash
Task: "Write failing backend contract coverage for live document search in /Users/dm/conductor/workspaces/radioso/document-search/backend/tests/contract/document.contract.test.ts"
Task: "Write failing backend integration coverage for ranked live document search and no-results responses in /Users/dm/conductor/workspaces/radioso/document-search/backend/tests/integration/persistence.integration.test.ts"
Task: "Write failing backend unit coverage for filter handling and document deduplication in /Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Write failing backend contract coverage for search history list and replay endpoints in /Users/dm/conductor/workspaces/radioso/document-search/backend/tests/contract/document.contract.test.ts"
Task: "Write failing backend unit coverage for shared trace reuse and snapshot replay behavior in /Users/dm/conductor/workspaces/radioso/document-search/backend/tests/unit/document-search-history.test.ts"
Task: "Write failing backend integration coverage for persisted search replay after underlying document changes in /Users/dm/conductor/workspaces/radioso/document-search/backend/tests/integration/persistence.integration.test.ts"
```

## Parallel Example: User Story 4

```bash
Task: "Integrate the extracted search bar, results, and history components into /Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx"
Task: "Add explicit loading, failure, no-results, and clear-search state treatment in /Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-bar.tsx, /Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/document-search-results.tsx, and /Users/dm/conductor/workspaces/radioso/document-search/frontend/components/dashboard/documents-view.tsx"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate live headless document search independently before adding replay/history or dashboard wiring

### Incremental Delivery

1. Add shared search services, audit-event replay seams, trace helpers, and OpenAPI schemas
2. Add live search execution and headless client contract
3. Add persisted history listing and snapshot replay with shared diagnostics
4. Add guaranteed result actions and replay-vs-live distinctions
5. Add dashboard top-bar search integration and explicit in-page states
6. Run final contract, regression, and UI verification

### Parallel Team Strategy

1. One engineer owns backend search services, routes, and OpenAPI schema updates
2. One engineer owns audit-event replay and shared trace integration after the live search contract stabilizes
3. One engineer owns frontend extraction and dashboard search/history UI once `frontend/lib/api.ts` contracts are in place

## Notes

- Total tasks: 45
- User story task counts: US1 = 8, US2 = 9, US3 = 6, US4 = 4
- Suggested MVP scope: Phase 3 / User Story 1
- Parallel opportunities identified in Setup, Foundational, each backend test phase, and final verification
- Independent test criteria:
  - US1: live document search returns ranked results, `searchId`, and explicit no-results behavior
  - US2: history list and replay return stored snapshots and shared diagnostics without rerunning retrieval
  - US3: ranked results expose the guaranteed v1 actions with explicit unavailable states for stale downstream actions
  - US4: Documents top-bar search renders in place and clears back to plain browsing cleanly
- All tasks follow the required checklist format with task id, labels, and file paths
