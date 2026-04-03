# Tasks: High-Cardinality Cursor Hardening

**Input**: Design documents from `/specs/035-large-result-cursors/`  
**Prerequisites**: [plan.md](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/plan.md), [spec.md](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/spec.md), [research.md](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/research.md), [data-model.md](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/data-model.md), [quickstart.md](/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/quickstart.md)

**Tests**: Backend tests are REQUIRED and MUST be written before implementation. Frontend verification follows the feature spec and existing repo practices.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare shared scale fixtures and cursor-safe client typing used across multiple stories.

- [ ] T001 [P] Add shared large-collection fixture helpers for documents, conversations, messages, and audit events in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/support/fakes.ts`
- [ ] T002 [P] Add shared cursor page response typings and helpers in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/lib/api.ts`
- [ ] T003 [P] Document the current route inventory and prerequisite-script branch mismatch in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/research.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared cursor and bounded-read seams before any story-specific migration begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 [P] Add failing unit coverage for shared cursor encoding, decoding, and invalid-input handling in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/unit/cursor-pagination.test.ts`
- [ ] T005 [P] Add failing contract coverage for cursor-based list and message-window query shapes in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/contract/openapi.contract.test.ts`
- [ ] T006 [P] Add failing integration coverage proving hot list endpoints do not depend on unbounded repository reads in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/large-result-guardrails.integration.test.ts`
- [ ] T007 Create shared cursor pagination types and codec helpers in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/shared/domain/cursorPagination.ts`
- [ ] T008 Add code-first cursor request and response schemas for collection windows in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/openapi/document.ts`
- [ ] T009 Introduce shared cursor parsing helpers for transport-only routes in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/chatRoutes.ts`
- [ ] T010 Introduce shared cursor parsing helpers for transport-only routes in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/documentRoutes.ts`

**Checkpoint**: Shared cursor contract and guardrail tests are ready for story work.

---

## Phase 3: User Story 1 - Browse large collections safely (Priority: P1) 🎯 MVP

**Goal**: Every hot collection-browsing route returns only bounded summary windows and no longer relies on unbounded repository reads.

**Independent Test**: Seed large documents, chat history, anonymous history, and search-history collections, hit the list routes, and confirm each request returns bounded summaries without using full-library reads.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T011 [P] [US1] Add failing documents list scale coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/document-list.integration.test.ts`
- [ ] T012 [P] [US1] Add failing chat history and anonymous history scale coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/chat-history.integration.test.ts`
- [ ] T013 [P] [US1] Add failing document search history scale coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/document-search-history.integration.test.ts`
- [ ] T014 [P] [US1] Add failing contract assertions for bounded collection summaries in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/contract/chat.contract.test.ts`

### Implementation for User Story 1

- [ ] T015 [P] [US1] Remove hot-path dependence on unbounded document reads by narrowing list seams in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/documents/services/documentIngestionService.ts`
- [ ] T016 [P] [US1] Remove hot-path dependence on unbounded conversation reads in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/chat/services/chatHistoryService.ts`
- [ ] T017 [P] [US1] Add or narrow bounded summary-only document repository methods in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/documentRepository.ts`
- [ ] T018 [P] [US1] Add or narrow bounded summary-only conversation repository methods in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/conversationRepository.ts`
- [ ] T019 [P] [US1] Add or narrow bounded document search history reads in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/auditEventRepository.ts`
- [ ] T020 [US1] Keep document search history orchestration summary-only in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/documents/services/documentSearchHistoryService.ts`
- [ ] T021 [US1] Update authenticated and anonymous list routes to emit bounded collection windows only in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/chatRoutes.ts`
- [ ] T022 [US1] Update document and search-history list routes to emit bounded collection windows only in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/documentRoutes.ts`

**Checkpoint**: High-cardinality list routes are all bounded and summary-only, even before cursor migration is complete.

---

## Phase 4: User Story 2 - Traverse large collections predictably (Priority: P1)

**Goal**: Documents, chat history, anonymous history, and document search history move from offset traversal to cursor/keyset traversal with deterministic ordering.

**Independent Test**: Request consecutive windows across each collection while records are inserted or deleted, and verify stable next-window behavior without duplicates or skipped rows.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T023 [P] [US2] Add failing keyset pagination unit coverage for timestamp-plus-id tie handling in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/unit/cursor-pagination.test.ts`
- [ ] T024 [P] [US2] Add failing documents cursor integration coverage under concurrent churn in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/document-list.integration.test.ts`
- [ ] T025 [P] [US2] Add failing chat and anonymous history cursor integration coverage under concurrent churn in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/chat-history.integration.test.ts`
- [ ] T026 [P] [US2] Add failing search-history cursor integration coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/document-search-history.integration.test.ts`
- [ ] T027 [P] [US2] Add failing contract coverage for cursor-based list params and responses in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/contract/settings.contract.test.ts`

### Implementation for User Story 2

- [ ] T028 [P] [US2] Add cursor-based document list queries and deterministic ordering in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/documentRepository.ts`
- [ ] T029 [P] [US2] Add cursor-based authenticated and anonymous conversation list queries in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/conversationRepository.ts`
- [ ] T030 [P] [US2] Add cursor-based document search history queries in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/auditEventRepository.ts`
- [ ] T031 [P] [US2] Add composite list-traversal indexes for documents, conversations, and audit events in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/migrations/012_cursor_pagination_indexes.sql`
- [ ] T032 [US2] Update document list orchestration to accept `cursor` and emit `nextCursor` and `hasMore` in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/documents/services/documentIngestionService.ts`
- [ ] T033 [US2] Update chat history orchestration to accept `cursor` and emit `nextCursor` and `hasMore` in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/chat/services/chatHistoryService.ts`
- [ ] T034 [US2] Update document search history orchestration to accept `cursor` and emit `nextCursor` and `hasMore` in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/documents/services/documentSearchHistoryService.ts`
- [ ] T035 [US2] Update code-first OpenAPI list contracts to replace hot-path offset traversal with cursor traversal in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/openapi/document.ts`
- [ ] T036 [US2] Update frontend collection clients to call cursor-based list endpoints in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/lib/api.ts`
- [ ] T037 [US2] Update document list view to store continuation state instead of page offsets in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/components/dashboard/documents-view.tsx`
- [ ] T038 [US2] Update chat history and route-state helpers for continuation-based browsing in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/components/dashboard/chat-history-view.tsx`
- [ ] T039 [US2] Update dashboard URL state helpers for cursor-based collection navigation in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/lib/dashboard-routes.ts`
- [ ] T040 [US2] Update anonymous chat history bootstrap to use cursor-based conversation browsing in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/lib/anonymous-chat-context.tsx`

**Checkpoint**: Large list traversal uses keyset/cursor pagination end to end for authenticated, anonymous, and search-history surfaces.

---

## Phase 5: User Story 3 - Open long conversations without full-history loads (Priority: P2)

**Goal**: Conversation detail for authenticated and anonymous users uses bounded cursor-based message windows for loading older history.

**Independent Test**: Open a long conversation, verify only the newest bounded message window loads initially, then request older windows until history is exhausted without duplicates or full-history responses.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T041 [P] [US3] Add failing message-window cursor unit coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/unit/message-repository.test.ts`
- [ ] T042 [P] [US3] Add failing authenticated conversation-detail cursor integration coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/chat-history.integration.test.ts`
- [ ] T043 [P] [US3] Add failing anonymous conversation-detail cursor integration coverage in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/contract/public-chat.contract.test.ts`

### Implementation for User Story 3

- [ ] T044 [P] [US3] Add cursor-based message window queries with deterministic ordering in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/repositories/messageRepository.ts`
- [ ] T045 [P] [US3] Add composite conversation-message traversal index in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/db/migrations/012_cursor_pagination_indexes.sql`
- [ ] T046 [US3] Update conversation-detail orchestration to emit bounded message windows with `nextCursor` and `hasOlderMessages` in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/modules/chat/services/chatHistoryService.ts`
- [ ] T047 [US3] Update authenticated conversation-detail route to accept cursor-based older-message requests in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/chatRoutes.ts`
- [ ] T048 [US3] Update anonymous conversation-detail route to accept cursor-based older-message requests in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/src/app/http/routes/publicChatRoutes.ts`
- [ ] T049 [US3] Update frontend chat history detail and public conversation history loading to request older message windows by cursor in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/components/dashboard/chat-history-view.tsx`
- [ ] T050 [US3] Update anonymous conversation detail state to append older windows predictably in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/lib/anonymous-chat-context.tsx`

**Checkpoint**: Long conversation detail is bounded and incrementally navigable for both authenticated and anonymous flows.

---

## Phase 6: User Story 4 - Verify every high-cardinality path is covered (Priority: P3)

**Goal**: The feature package records the reviewed route inventory, migration status, and validation evidence so scale hardening remains durable.

**Independent Test**: Review the feature docs and verify every user-generated high-cardinality route is listed with its owner, bounded strategy, and validation coverage.

### Tests for User Story 4 (REQUIRED for backend)

- [ ] T051 [P] [US4] Add failing route-inventory regression coverage for all hardened collection routes in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/large-result-guardrails.integration.test.ts`

### Implementation for User Story 4

- [ ] T052 [P] [US4] Expand the route inventory and remediation notes in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/plan.md`
- [ ] T053 [P] [US4] Record final cursor contract decisions and deferred paths in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/research.md`
- [ ] T054 [US4] Update validation and operator workflow notes in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/quickstart.md`

**Checkpoint**: The route inventory and cursor migration decisions are documented and regression-guarded.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Regenerate artifacts, validate the feature end to end, and clean up deprecated hot-path offset assumptions.

- [ ] T055 [P] Regenerate generated OpenAPI artifacts in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/openapi.json`
- [ ] T056 [P] Run focused backend contract validation for cursor-based list and detail endpoints in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/contract/`
- [ ] T057 [P] Run focused backend integration validation for large-result-set browsing in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/backend/tests/integration/`
- [ ] T058 [P] Run targeted frontend verification for documents, chat history, and anonymous history cursor flows in `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/`
- [ ] T059 Remove deprecated hot-path offset assumptions and dead helper code from `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/frontend/lib/documents-pagination.ts`
- [ ] T060 Run the validation scenarios from `/Users/dm/conductor/workspaces/radioso/radioso-competitor-map/specs/035-large-result-cursors/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on Foundational completion and should build on the bounded list seams from US1.
- **User Story 3 (Phase 5)**: Depends on Foundational completion and should follow the shared cursor contract from US2.
- **User Story 4 (Phase 6)**: Depends on the route inventory and migrated surfaces from prior stories.
- **Polish (Phase 7)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; no dependency on cursor rollout.
- **User Story 2 (P1)**: Depends on US1 bounded summary seams so cursor migration does not preserve hidden unbounded paths.
- **User Story 3 (P2)**: Depends on the shared cursor contract and can proceed once US2 establishes message-window cursor semantics.
- **User Story 4 (P3)**: Depends on completed migrations and validation evidence from US1-US3.

### Within Each User Story

- Backend tests MUST be written and FAIL before implementation.
- Shared domain helpers and contracts land before repository and orchestration changes.
- Repository query changes land before service wiring.
- Service wiring lands before route and frontend updates.
- Each story must be independently testable before moving on.

### Parallel Opportunities

- Phase 1 setup tasks marked `[P]` can run in parallel.
- In Phase 2, failing tests and OpenAPI schema work can proceed in parallel before route helper wiring.
- In US1, repository narrowing tasks for documents, conversations, and audit events can proceed in parallel.
- In US2, repository keyset work for documents, conversations, and search history can proceed in parallel, as can frontend client/view migrations after the contract stabilizes.
- In US3, message repository work and frontend detail-state work can proceed in parallel once the route contract is set.
- In US4, documentation updates can proceed in parallel once validation evidence exists.

---

## Parallel Example: User Story 2

```bash
# Launch repository cursor migrations together:
Task: "Add cursor-based document list queries and deterministic ordering in backend/src/db/repositories/documentRepository.ts"
Task: "Add cursor-based authenticated and anonymous conversation list queries in backend/src/db/repositories/conversationRepository.ts"
Task: "Add cursor-based document search history queries in backend/src/db/repositories/auditEventRepository.ts"

# Launch frontend collection migrations together after backend contracts settle:
Task: "Update document list view to store continuation state instead of page offsets in frontend/components/dashboard/documents-view.tsx"
Task: "Update chat history and route-state helpers for continuation-based browsing in frontend/components/dashboard/chat-history-view.tsx"
Task: "Update anonymous chat history bootstrap to use cursor-based conversation browsing in frontend/lib/anonymous-chat-context.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Confirm all hot collection routes are bounded and summary-only.
5. Land the first safety improvement before cursor migration if desired.

### Incremental Delivery

1. Complete Setup + Foundational to establish the shared cursor contract.
2. Add User Story 1 to eliminate remaining unbounded hot paths.
3. Add User Story 2 to move list traversal to cursor/keyset pagination.
4. Add User Story 3 to migrate long conversation detail windows.
5. Add User Story 4 to lock in route inventory and validation documentation.
6. Finish with artifact regeneration and quickstart validation.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together.
2. Once Foundational is done:
   - Developer A: User Story 1 bounded-read hardening
   - Developer B: User Story 2 repository and contract cursor rollout
   - Developer C: User Story 2 frontend collection migration after contracts settle
3. Then:
   - Developer A: User Story 3 message-window backend
   - Developer B: User Story 3 frontend detail loading
   - Developer C: User Story 4 documentation and validation inventory

---

## Notes

- `[P]` tasks touch separate files or can proceed after a clearly stated upstream seam is in place.
- `[US1]` through `[US4]` preserve traceability to the approved user stories.
- The repo constitution requires backend TDD and code-first OpenAPI updates; those tasks are explicit above.
- The Speckit prerequisite script currently rejects the Conductor-mandated branch naming format, so task generation for this feature was completed manually against the approved spec package.
