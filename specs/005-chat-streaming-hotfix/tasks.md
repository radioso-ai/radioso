# Tasks: Chat Streaming Hotfix

**Input**: Design documents from `/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/`
**Prerequisites**: [plan.md](/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/plan.md), [spec.md](/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/spec.md)

**Tests**: Backend TDD is required. Write failing unit/contract coverage before implementation.

## Phase 1: Setup

- [X] T001 Align `/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/plan.md` and this task list with the approved hotfix scope

## Phase 2: Foundational

- [X] T002 Add failing incremental-stream contract coverage in `/tmp/radioso-chat-streaming-hotfix/backend/tests/contract/chat.contract.test.ts`
- [X] T003 [P] Add failing chat streaming lifecycle unit coverage in `/tmp/radioso-chat-streaming-hotfix/backend/tests/unit/chat-service-streaming.test.ts`

## Phase 3: User Story 1 - Receive Real Incremental Chat Chunks (Priority: P1)

**Goal**: Forward true model chunks over SSE and persist the completed assistant message only after successful stream completion

**Independent Test**: Use delayed fake streaming chunks to verify chunk delivery precedes the final done event and that the completed assistant message is persisted

- [X] T004 [US1] Refactor chat streaming orchestration in `/tmp/radioso-chat-streaming-hotfix/backend/src/modules/chat/services/chatService.ts`
- [X] T005 [P] [US1] Refactor SSE presenter and route integration in `/tmp/radioso-chat-streaming-hotfix/backend/src/app/http/presenters/chatPresenter.ts` and `/tmp/radioso-chat-streaming-hotfix/backend/src/app/http/routes/chatRoutes.ts`
- [X] T006 [P] [US1] Extend test support fakes in `/tmp/radioso-chat-streaming-hotfix/backend/tests/support/testApp.ts`

## Phase 4: Polish

- [X] T007 Run backend contract and unit validation in `/tmp/radioso-chat-streaming-hotfix/backend`
- [X] T008 Update `/tmp/radioso-chat-streaming-hotfix/specs/005-chat-streaming-hotfix/tasks.md` with final completion state

## Validation Notes

- `npm test -- --run tests/contract/chat.contract.test.ts tests/unit/chat-service-streaming.test.ts` PASS
- `npm run build` PASS
- `npm test` PARTIAL: hotfix tests passed, but pre-existing unrelated failure remains in `tests/contract/settings.contract.test.ts` because the current default `vectorTopK` is `15` while the test expects `10`
