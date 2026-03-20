# Quickstart: Anonymous Chat Access

## Prerequisites

- Node.js backend running with PostgreSQL
- Frontend dev server running
- At least one workspace with documents ingested

## Implementation Order

### 1. Database Migration

Create `backend/src/db/migrations/009_anonymous_chat.sql`:
- Add `anonymous_chat_enabled` (BOOLEAN DEFAULT false) and `anonymous_chat_token` (TEXT) to `workspaces`
- Add `anonymous_session_id` (TEXT) to `conversations`
- Add partial index on `conversations(workspace_id, anonymous_session_id)`

### 2. Backend: Workspace Repository Changes

Update `workspaceRepository.ts` to read/write the new columns. Add a method to look up a workspace by `anonymous_chat_token`.

### 3. Backend: Anonymous Session Middleware

Create `backend/src/app/http/middleware/resolveAnonymousSession.ts`:
- Extract `:token` from URL params
- Look up workspace by token, verify `anonymous_chat_enabled`
- Read `anon_session` cookie; if absent, generate UUID and set cookie
- Populate `res.locals.workspaceId` and `res.locals.anonymousSessionId`

### 4. Backend: Public Chat Routes

Create `backend/src/app/http/routes/publicChatRoutes.ts`:
- `POST /api/v1/public/chat/:token` — send message (reuses `ChatService`)
- `GET /api/v1/public/chat/:token` — list conversations for session
- `GET /api/v1/public/chat/:token/history/:conversationId` — conversation detail

### 5. Backend: General Settings Endpoint

Add to existing `settingsRoutes.ts` or create new route:
- `GET /api/v1/settings/general` — returns `{ anonymousChatEnabled, anonymousChatUrl }`
- `PUT /api/v1/settings/general` — toggles `anonymousChatEnabled`, generates token on first enable

### 6. Backend: Update ChatService & ConversationRepository

- `ConversationRepository.create()` — accept optional `anonymousSessionId`
- `ConversationRepository.listByAnonymousSession()` — filter by `workspace_id + anonymous_session_id`
- `ChatService` — accept anonymous session context (no `accountId` required)

### 7. Frontend: Settings UI

Update `settings-view.tsx` General tab:
- Add "Anonymous Chat Access" toggle (Switch component)
- Show public URL with copy button when enabled
- Call `PUT /api/v1/settings/general` on toggle

### 8. Frontend: Public Chat Page

Create `frontend/app/chat/[token]/page.tsx`:
- No auth guard, no sidebar
- Provide anonymous chat context that calls `/api/v1/public/chat/:token`
- Render existing `ChatView` component

### 9. Frontend: Admin Chat History Labels

Update `chat-history-view.tsx`:
- Show "Anonymous" label on conversations where `sourceChannel === 'anonymous'`

## Verification

1. Enable anonymous chat in Settings → General
2. Set rate limit (e.g., 5 messages/min)
3. Copy the public URL
4. Open in incognito browser — should see chat interface, no login
5. Send messages — should get bot responses
6. Send messages rapidly past the limit — should see rate limit error with countdown
7. Close and reopen — conversation history persists
8. Disable toggle — URL shows "Chat unavailable"
9. Check admin chat history — anonymous conversations labeled
