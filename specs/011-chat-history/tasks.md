# Tasks: Chat History Debug Drawer

## Phase 1: Setup

- [X] T001 Review existing chat route, sidebar, live chat debug UI, and persistence seams in `/Users/dm/code/radioso-chat-history/backend/src` and `/Users/dm/code/radioso-chat-history/frontend/components/dashboard`
- [X] T002 Replace the placeholder specification artifacts with an approved scope and requirements in `/Users/dm/code/radioso-chat-history/specs/011-chat-history/spec.md` and `/Users/dm/code/radioso-chat-history/specs/011-chat-history/checklists/requirements.md`

## Phase 2: Foundational

- [X] T003 Define the history delivery plan and validation strategy in `/Users/dm/code/radioso-chat-history/specs/011-chat-history/plan.md`
- [X] T004 Extend persistence and dependency seams for history reads in `/Users/dm/code/radioso-chat-history/backend/src/db/repositories/conversationRepository.ts`, `/Users/dm/code/radioso-chat-history/backend/src/db/repositories/auditEventRepository.ts`, `/Users/dm/code/radioso-chat-history/backend/src/app/server/types.ts`, and `/Users/dm/code/radioso-chat-history/backend/src/app/server/dependencies.ts`

## Phase 3: User Story 1 - Browse prior chats from History

- [X] T005 [US1] Add account-scoped history list/detail endpoints in `/Users/dm/code/radioso-chat-history/backend/src/app/http/routes/chatRoutes.ts`
- [X] T006 [US1] Implement history read orchestration in `/Users/dm/code/radioso-chat-history/backend/src/modules/chat/services/chatHistoryService.ts`
- [X] T007 [US1] Add history API contracts and route parsing in `/Users/dm/code/radioso-chat-history/frontend/lib/api.ts` and `/Users/dm/code/radioso-chat-history/frontend/lib/dashboard-routes.ts`
- [X] T008 [US1] Render the history screen and conversation list in `/Users/dm/code/radioso-chat-history/frontend/components/dashboard/chat-history-view.tsx` and `/Users/dm/code/radioso-chat-history/frontend/components/dashboard/dashboard-shell.tsx`

## Phase 4: User Story 2 - Inspect a conversation in a right-side drawer

- [X] T009 [US2] Persist assistant-turn audit linkage for durable debug inspection in `/Users/dm/code/radioso-chat-history/backend/src/modules/chat/services/chatService.ts`
- [X] T010 [US2] Show transcript and debug metadata in the right-side drawer in `/Users/dm/code/radioso-chat-history/frontend/components/dashboard/chat-history-view.tsx`
- [X] T011 [US2] Cover history payloads and debug details with contract and integration tests in `/Users/dm/code/radioso-chat-history/backend/tests/contract/chat.contract.test.ts` and `/Users/dm/code/radioso-chat-history/backend/tests/integration/chat.integration.test.ts`

## Phase 5: User Story 3 - Keep live chat clean while preserving debug visibility in history

- [X] T012 [US3] Remove inline debug rendering from the live chat surface in `/Users/dm/code/radioso-chat-history/frontend/components/dashboard/chat-view.tsx`
- [X] T013 [US3] Present the `History` submenu under `Chat` in `/Users/dm/code/radioso-chat-history/frontend/components/dashboard/app-sidebar.tsx`
- [X] T014 [US3] Keep test support aligned with the new history service and audit repository contract in `/Users/dm/code/radioso-chat-history/backend/tests/support/fakes.ts`, `/Users/dm/code/radioso-chat-history/backend/tests/support/testApp.ts`, and `/Users/dm/code/radioso-chat-history/backend/tests/integration/persistence.integration.test.ts`

## Phase 6: Validation

- [X] T015 Run backend build validation in `/Users/dm/code/radioso-chat-history/backend`
- [X] T016 Run targeted backend contract/integration/unit validation in `/Users/dm/code/radioso-chat-history/backend`
- [X] T017 Run frontend production build validation in `/Users/dm/code/radioso-chat-history/frontend`
