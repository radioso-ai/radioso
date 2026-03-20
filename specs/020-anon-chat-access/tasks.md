# Tasks: Anonymous Chat Access

**Input**: Design documents from `/specs/020-anon-chat-access/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/public-chat-api.yaml, quickstart.md

**Tests**: Backend tests are REQUIRED per constitution (TDD). Tests MUST be written and fail before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Architecture**: New transport lives in `publicChatRoutes.ts`. Anonymous session resolution is middleware. `chatRoutes.ts` and `requireApiToken.ts` are NOT modified. `ChatService` is reused with minimal changes. Frontend reuses existing chat components.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Database migration and shared infrastructure for anonymous chat

- [x] T001 Create database migration in `backend/src/db/migrations/009_anonymous_chat.sql` — add `anonymous_chat_enabled BOOLEAN DEFAULT false`, `anonymous_chat_token TEXT`, and `anonymous_rate_limit INTEGER DEFAULT 10` columns to `workspaces` table, add `anonymous_session_id TEXT` column to `conversations` table, add partial index `idx_conversations_anonymous_session ON conversations(workspace_id, anonymous_session_id) WHERE anonymous_session_id IS NOT NULL`
- [x] T002 Update `.env.example` with `PUBLIC_CHAT_BASE_URL` variable (base URL for generating shareable anonymous chat links)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Repository and middleware changes that all user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational

- [x] T003 [P] Unit test for anonymous session middleware in `backend/tests/unit/anonymous-session.test.ts` — test cookie read/create logic, workspace lookup by token, rejection when `anonymous_chat_enabled` is false, 404 when token not found
- [x] T004 [P] Unit test for workspace repository token lookup in `backend/tests/unit/workspace-repository.test.ts` — test `findByAnonymousChatToken` returns workspace when found, null when not, and `updateAnonymousChatSettings` sets token, enabled flag, and rate limit
- [x] T004b [P] Unit test for anonymous rate limiter in `backend/tests/unit/anonymous-rate-limiter.test.ts` — test allows messages under limit, rejects at limit with `retryAfterSeconds`, resets after window expires, respects different limits per workspace, handles concurrent sessions independently

### Implementation for Foundational

- [x] T005 [P] Extend workspace repository in `backend/src/db/repositories/workspaceRepository.ts` — add `findByAnonymousChatToken(token): Promise<WorkspaceRecord | null>` method, add `updateAnonymousChatSettings(workspaceId, enabled, token, rateLimit): Promise<void>` method, update `WorkspaceRecord` type to include `anonymousChatEnabled`, `anonymousChatToken`, and `anonymousRateLimit` fields
- [x] T006 [P] Extend conversation repository in `backend/src/db/repositories/conversationRepository.ts` — update `create()` to accept optional `anonymousSessionId` and `sourceChannel` params, add `listByAnonymousSession(workspaceId, anonymousSessionId): Promise<ConversationRecord[]>` method, add `findByIdAndAnonymousSession(conversationId, anonymousSessionId): Promise<ConversationRecord | null>` method
- [x] T007 Create `resolveAnonymousSession` middleware in `backend/src/app/http/middleware/resolveAnonymousSession.ts` — extract `:token` from URL params, call `workspaceRepository.findByAnonymousChatToken(token)`, verify `anonymous_chat_enabled` is true (else 404), read `anon_session` cookie or generate UUID and set HTTP-only cookie (30-day expiry, Secure in production, SameSite=Lax), populate `res.locals.workspaceId`, `res.locals.anonymousSessionId`, and `res.locals.anonymousRateLimit`
- [x] T007b Create `anonymousRateLimiter` middleware in `backend/src/app/http/middleware/anonymousRateLimiter.ts` — in-memory sliding window counter keyed by `anonymousSessionId`, reads limit from `res.locals.anonymousRateLimit` (set by `resolveAnonymousSession`), returns 429 with `{ code: "rate_limit_exceeded", message, retryAfterSeconds }` when exceeded, automatically cleans up expired entries
- [x] T008 Update in-memory fakes in `backend/tests/support/fakes.ts` — add `findByAnonymousChatToken`, `updateAnonymousChatSettings` to `InMemoryWorkspaceRepository`, add `listByAnonymousSession`, `findByIdAndAnonymousSession`, and `anonymousSessionId` support in `create()` to `InMemoryConversationRepository`

**Checkpoint**: Foundation ready — workspace token lookup, anonymous session middleware, and conversation repository changes are in place

---

## Phase 3: User Story 1 — Admin Enables Anonymous Chat (Priority: P1) 🎯 MVP

**Goal**: Admin toggles anonymous chat on/off in General Settings. When on, a shareable public URL is displayed with copy-to-clipboard.

**Independent Test**: Toggle setting on in General Settings, verify URL appears and can be copied. Toggle off, verify URL disappears.

### Tests for User Story 1 (REQUIRED)

- [x] T009 [P] [US1] Contract test for general settings endpoints in `backend/tests/contract/general-settings.contract.test.ts` — test `GET /api/v1/settings/general` returns `{ anonymousChatEnabled, anonymousChatUrl, anonymousRateLimit }`, test `PUT /api/v1/settings/general` with `{ anonymousChatEnabled: true }` generates token and returns URL, test updating `anonymousRateLimit` persists value, test toggling off preserves token but returns null URL, test unauthenticated access returns 401

### Implementation for User Story 1

- [x] T010 [US1] Add general settings endpoints to `backend/src/app/http/routes/settingsRoutes.ts` — add `GET /api/v1/settings/general` (returns `anonymousChatEnabled`, `anonymousChatUrl` built from `PUBLIC_CHAT_BASE_URL + token`, and `anonymousRateLimit`), add `PUT /api/v1/settings/general` (accepts `{ anonymousChatEnabled, anonymousRateLimit }`, generates 22-char base64url token on first enable via `crypto.randomBytes(16)`, validates `anonymousRateLimit` is integer 1–60, calls `workspaceRepository.updateAnonymousChatSettings`), both use existing `requireApiToken` middleware
- [x] T011 [US1] Mount general settings routes in `backend/src/app/http/routes/index.ts` if needed (may already be in settingsRoutes)
- [x] T012 [US1] Wire workspace repository into settings route dependencies in `backend/src/app/server/dependencies.ts` if not already available
- [x] T013 [US1] Update General tab in `frontend/components/dashboard/settings-view.tsx` — add "Anonymous Chat Access" section with Switch component (Shadcn), show/hide public URL text with copy-to-clipboard Button when enabled, add "Rate Limit" number input (1–60 messages/min, default 10) visible when toggle is on, call `PUT /api/v1/settings/general` on toggle or rate limit change, call `GET /api/v1/settings/general` on mount to load current state
- [x] T014 [US1] Add general settings API methods to `frontend/lib/api.ts` — add `getGeneralSettings(workspaceToken): Promise<GeneralSettings>` and `updateGeneralSettings(workspaceToken, body): Promise<GeneralSettings>` methods

**Checkpoint**: Admin can toggle anonymous chat and see/copy the public URL. Story 1 is fully functional and testable independently.

---

## Phase 4: User Story 2 — Anonymous User Chats via Public Link (Priority: P1)

**Goal**: Unauthenticated users open the public URL, land on a chat interface, send messages, and get bot responses. Conversations persist via cookie.

**Independent Test**: Open public URL in incognito browser, send messages, receive responses, close/reopen to verify history persists.

### Tests for User Story 2 (REQUIRED)

- [x] T015 [P] [US2] Contract test for public chat endpoints in `backend/tests/contract/public-chat.contract.test.ts` — test `POST /api/v1/public/chat/:token` creates conversation and returns bot response with `Set-Cookie`, test subsequent requests with cookie reuse the same session, test `GET /api/v1/public/chat/:token` returns conversations for the session, test `GET /api/v1/public/chat/:token/history/:conversationId` returns messages, test invalid token returns 404, test disabled workspace returns 404, test exceeding rate limit returns 429 with `retryAfterSeconds`
- [x] T016 [P] [US2] Integration test for anonymous chat flow in `backend/tests/integration/anonymous-chat.integration.test.ts` — test full flow: enable anonymous chat → get token → POST chat as anonymous user → verify conversation created with `source_channel='anonymous'` and `anonymous_session_id` set → verify history endpoint returns conversation

### Implementation for User Story 2

- [x] T017 [US2] Update `ChatService` in `backend/src/modules/chat/services/chatService.ts` — modify `answer()` and `streamAnswer()` to accept optional `anonymousSessionId` parameter (instead of requiring `accountId`), pass `anonymousSessionId` and `sourceChannel='anonymous'` to `conversationRepository.create()` when present
- [x] T018 [US2] Create public chat routes in `backend/src/app/http/routes/publicChatRoutes.ts` — `POST /api/v1/public/chat/:token` (uses `resolveAnonymousSession` then `anonymousRateLimiter` middleware, delegates to `ChatService.answer/streamAnswer` with anonymous context), `GET /api/v1/public/chat/:token` (list conversations for anonymous session via `conversationRepository.listByAnonymousSession`), `GET /api/v1/public/chat/:token/history/:conversationId` (get conversation detail, verify it belongs to the anonymous session)
- [x] T019 [US2] Mount public chat routes in `backend/src/app/http/routes/index.ts` and wire dependencies in `backend/src/app/server/dependencies.ts`
- [x] T020 [US2] Create anonymous chat context provider in `frontend/lib/anonymous-chat-context.tsx` — provide workspace token from URL param, manage conversation state, call public chat API endpoints (no auth headers, cookie-based), expose same interface shape that `ChatView` expects
- [x] T021 [US2] Create public chat layout in `frontend/app/chat/[token]/layout.tsx` — minimal layout with no sidebar, no auth guard, no navigation chrome, just a centered container with workspace branding
- [x] T022 [US2] Create public chat page in `frontend/app/chat/[token]/page.tsx` — wrap existing `ChatView` component with `AnonymousChatProvider`, handle "chat unavailable" state when API returns 404 (show user-friendly message), handle 429 rate limit response by showing inline error with retry countdown
- [x] T023 [US2] Add public chat API methods to `frontend/lib/api.ts` — add `publicChat(token, body)`, `publicChatHistory(token)`, `publicConversationDetail(token, conversationId)` methods that call `/api/v1/public/chat/:token` endpoints without auth headers

**Checkpoint**: Anonymous users can chat via the public URL with conversation persistence. Story 2 is fully functional and testable independently.

---

## Phase 5: User Story 3 — Admin Monitors Anonymous Conversations (Priority: P2)

**Goal**: Admin sees anonymous conversations in chat history, labeled distinctly from authenticated ones.

**Independent Test**: Enable anonymous chat, have anonymous users chat, verify admin sees labeled anonymous conversations in history.

### Tests for User Story 3 (REQUIRED)

- [x] T024 [US3] Contract test for anonymous conversation visibility in `backend/tests/contract/chat.contract.test.ts` — extend existing chat history tests to verify that conversations with `source_channel='anonymous'` appear in `GET /api/v1/chat/history` response with an `isAnonymous` flag or `sourceChannel` field

### Implementation for User Story 3

- [x] T025 [US3] Update `ChatHistoryService` in `backend/src/modules/chat/services/chatHistoryService.ts` — include `sourceChannel` field in conversation summaries returned by `listConversations()`, include `anonymousSessionId` in detail response
- [x] T026 [US3] Update chat history presenter in `backend/src/app/http/presenters/` (if exists) or in the route handler — ensure `sourceChannel` is included in the API response for each conversation
- [x] T027 [US3] Update `frontend/components/dashboard/chat-history-view.tsx` — show "Anonymous" badge/label on conversations where `sourceChannel === 'anonymous'`, use muted styling to visually distinguish from authenticated conversations

**Checkpoint**: Admin has full visibility into anonymous conversations alongside authenticated ones.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final hardening and validation

- [x] T028 Verify cookie security settings in `resolveAnonymousSession.ts` — confirm `HttpOnly`, `Secure` (production), `SameSite=Lax`, 30-day expiry are correctly set
- [x] T029 Add audit event logging for anonymous chat in `backend/src/modules/audit/` — record `anonymous_chat_enabled`, `anonymous_chat_disabled`, and `anonymous_chat_message` events
- [ ] T030 Run full quickstart.md validation — enable toggle, copy URL, open in incognito, send messages, verify history persistence, disable toggle, verify unavailable page, check admin history labels

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (migration must exist) — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 (needs workspace repository methods)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (needs middleware, conversation repo methods). Can run in parallel with US1 but logically US1 should complete first (admin must enable before users can chat)
- **User Story 3 (Phase 5)**: Depends on Phase 2. Can run in parallel with US1/US2 on backend, but frontend needs US2 conversations to exist for meaningful testing
- **Polish (Phase 6)**: Depends on all stories being complete

### Within Each User Story

- Backend tests MUST be written and FAIL before implementation
- Models/repositories before services
- Services before route handlers
- Backend before frontend (API must exist for frontend to call)
- Core implementation before integration

### Parallel Opportunities

- T003 and T004 (foundational tests) can run in parallel
- T005 and T006 (repository changes) can run in parallel
- T009, T015, T016 (all test tasks across stories) can run in parallel after Phase 2
- T013 and T014 (frontend settings UI + API methods) can run in parallel
- T020, T021, T022, T023 (frontend anonymous chat) — T020 and T023 in parallel, then T021 and T022

---

## Parallel Example: User Story 2

```bash
# Launch tests in parallel:
Task: "Contract test for public chat in backend/tests/contract/public-chat.contract.test.ts"
Task: "Integration test for anonymous chat in backend/tests/integration/anonymous-chat.integration.test.ts"

# Launch frontend tasks in parallel (after backend complete):
Task: "Create anonymous chat context in frontend/lib/anonymous-chat-context.tsx"
Task: "Add public chat API methods to frontend/lib/api.ts"
# Then sequentially:
Task: "Create public chat layout in frontend/app/chat/[token]/layout.tsx"
Task: "Create public chat page in frontend/app/chat/[token]/page.tsx"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (migration)
2. Complete Phase 2: Foundational (repository + middleware)
3. Complete Phase 3: User Story 1 (admin toggle + URL)
4. Complete Phase 4: User Story 2 (anonymous chat page)
5. **STOP and VALIDATE**: Full anonymous chat flow works end-to-end
6. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (admin toggle) → Test independently → **MVP milestone**
3. Add US2 (anonymous chat) → Test independently → **Core feature complete**
4. Add US3 (admin monitoring) → Test independently → **Full feature complete**
5. Polish → Hardened and production-ready

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- `chatRoutes.ts` and `requireApiToken.ts` are NOT modified (anti-goal from spec)
- `ChatView` component is REUSED, not duplicated (DRY anti-goal from spec)
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
