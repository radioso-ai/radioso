# Tasks: Chat Route Citations

**Input**: Design documents from `/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/`
**Prerequisites**: [plan.md](/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/plan.md), [spec.md](/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/spec.md), [research.md](/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/research.md), [data-model.md](/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/data-model.md), [contracts/openapi.yaml](/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/contracts/openapi.yaml), [quickstart.md](/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/quickstart.md)

**Tests**: Frontend validation relies on lint and build checks. Existing backend contract coverage remains the regression safety net for streaming and document APIs.

**Organization**: Tasks are grouped by user story so each story can be implemented and verified independently once the foundational route and session seams exist.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel when dependencies are satisfied
- **[Story]**: Maps the task to a user story from the spec
- Every task includes an exact file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Align feature documentation and define the reusable route/session seams before UI changes land

- [x] T001 Align `/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/plan.md`, `research.md`, `data-model.md`, `contracts/openapi.yaml`, and `quickstart.md` with the approved spec
- [x] T002 [P] Create account route helpers in `/private/tmp/radioso-chat-frontend-routes/frontend/lib/dashboard-routes.ts`
- [x] T003 [P] Create chat session state ownership in `/private/tmp/radioso-chat-frontend-routes/frontend/lib/chat-context.tsx`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Replace local dashboard state with route-aware orchestration and keep shell components responsibility-limited

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create the account-scoped dashboard route entry point in `/private/tmp/radioso-chat-frontend-routes/frontend/app/account/[accountId]/[[...segments]]/page.tsx`
- [x] T005 [P] Extract route-aware dashboard shell composition into `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/dashboard-shell.tsx`
- [x] T006 [P] Refactor `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/app-sidebar.tsx` to use account-scoped route links instead of local callbacks
- [x] T007 Refactor `/private/tmp/radioso-chat-frontend-routes/frontend/app/page.tsx` and `/private/tmp/radioso-chat-frontend-routes/frontend/app/layout.tsx` to bootstrap auth, redirect authenticated users to account-scoped routes, and provide shared chat session state

**Checkpoint**: Route and session foundations are ready.

---

## Phase 3: User Story 1 - Read Answers With Inline Sources (Priority: P1) 🎯 MVP

**Goal**: Show inline citation markers with hover titles and navigate to the cited document route from chat

**Independent Test**: Ask a cited question, verify inline `[n]` markers render inside the assistant answer, hover reveals titles, and clicking opens the account-scoped document route

### Implementation for User Story 1

- [x] T008 [P] [US1] Create inline citation rendering helpers in `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/chat-citations.tsx`
- [x] T009 [P] [US1] Refactor `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/chat-view.tsx` to consume shared chat state and render inline citations instead of the footer source list
- [x] T010 [P] [US1] Refactor `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/documents-view.tsx` to open and close a selected document from route state
- [x] T011 [US1] Wire citation clicks and document list selection through `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/dashboard-shell.tsx` and `/private/tmp/radioso-chat-frontend-routes/frontend/lib/dashboard-routes.ts`

**Checkpoint**: User Story 1 is independently functional.

---

## Phase 4: User Story 2 - Receive Streaming Answers (Priority: P2)

**Goal**: Use the existing streamed chat endpoint so assistant text appears progressively before completion

**Independent Test**: Submit a question and confirm assistant text appears incrementally before the request completes, then final citations attach to the completed message

### Implementation for User Story 2

- [x] T012 [P] [US2] Add streamed chat request support and SSE parsing in `/private/tmp/radioso-chat-frontend-routes/frontend/lib/api.ts`
- [x] T013 [P] [US2] Extend `/private/tmp/radioso-chat-frontend-routes/frontend/lib/chat-context.tsx` with in-flight assistant message creation, chunk appends, completion, and fallback handling
- [x] T014 [US2] Refactor `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/chat-view.tsx` to submit streamed requests, display partial assistant output, and surface failure states cleanly

**Checkpoint**: User Stories 1 and 2 are independently functional.

---

## Phase 5: User Story 3 - Navigate By URL (Priority: P3)

**Goal**: Ensure every dashboard destination, including opened documents, is reflected in the browser URL and restored after reload

**Independent Test**: Navigate across dashboard routes, refresh each route, and confirm the same destination reappears after auth bootstrap

### Implementation for User Story 3

- [x] T015 [P] [US3] Normalize account and document route parsing plus auth mismatch recovery in `/private/tmp/radioso-chat-frontend-routes/frontend/app/account/[accountId]/[[...segments]]/page.tsx`
- [x] T016 [P] [US3] Remove obsolete local view-state orchestration from `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/dashboard.tsx` or replace it with route-driven composition
- [x] T017 [US3] Complete refresh-safe document and section navigation behavior in `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/documents-view.tsx`, `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/settings-view.tsx`, and `/private/tmp/radioso-chat-frontend-routes/frontend/components/dashboard/token-view.tsx` where needed

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation sync, and task completion

- [x] T018 [P] Run frontend lint in `/private/tmp/radioso-chat-frontend-routes/frontend`
- [x] T019 [P] Run frontend build in `/private/tmp/radioso-chat-frontend-routes/frontend`
- [x] T020 Update `/private/tmp/radioso-chat-frontend-routes/specs/003-chat-route-citations/quickstart.md` and this task list with final validation notes and completion state

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup**: No dependencies
- **Phase 2: Foundational**: Depends on Phase 1 and blocks all user stories
- **Phase 3: User Story 1**: Depends on Phase 2
- **Phase 4: User Story 2**: Depends on User Story 1 because streaming updates the same chat surface and shared session state
- **Phase 5: User Story 3**: Depends on Phase 2 and integrates the behavior from User Stories 1 and 2 into refresh-safe routes
- **Phase 6: Polish**: Depends on all implemented user stories

### User Story Dependencies

- **User Story 1 (P1)**: Requires route helpers and route-aware documents/chat shells
- **User Story 2 (P2)**: Builds on the shared chat session state and chat view from User Story 1
- **User Story 3 (P3)**: Finalizes refresh-safe routing around the already route-driven shell

### Within Each User Story

- Keep route parsing out of leaf UI widgets
- Keep `frontend/components/dashboard/app-sidebar.tsx` navigation-only
- Keep `frontend/lib/api.ts` transport-only
- Keep document loading inside `frontend/components/dashboard/documents-view.tsx`
- Keep inline citation rendering in focused chat-specific presentation code

### Parallel Opportunities

- `T002` and `T003` can run in parallel after `T001`
- `T005` and `T006` can run in parallel before integrating with `T004` and `T007`
- In User Story 1, `T008`, `T009`, and `T010` can run in parallel before `T011`
- In User Story 2, `T012` and `T013` can run in parallel before `T014`
- In User Story 3, `T015` and `T016` can run in parallel before `T017`
- Validation tasks `T018` and `T019` can run in parallel before `T020`

## Implementation Strategy

### MVP First

1. Complete setup and foundational phases
2. Deliver User Story 1 so citation-driven document navigation works from routed chat
3. Validate citation hover and click behavior before layering streaming

### Incremental Delivery

1. Land route foundations and shared chat state
2. Add inline citations and route-driven document opening
3. Add streamed chat behavior
4. Finish with refresh-safe route behavior and validation

## Notes

- Total tasks: 20
- User Story 1 tasks: 4
- User Story 2 tasks: 3
- User Story 3 tasks: 3
- Suggested MVP scope: Phase 1, Phase 2, and User Story 1
