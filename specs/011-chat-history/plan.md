# Implementation Plan: Chat History Debug Drawer

**Branch**: `011-chat-history` | **Date**: 2026-03-16 | **Spec**: [/Users/dm/code/hivec-chat-history/specs/011-chat-history/spec.md](/Users/dm/code/hivec-chat-history/specs/011-chat-history/spec.md)
**Input**: Feature specification from `/specs/011-chat-history/spec.md`

## Summary

Add an account-scoped chat history surface under `Chat > History`, expose conversation list/detail APIs for stored chats, render a right-side drawer with transcript plus debug metadata, and remove inline debug output from the live chat view. Persist debug inspectability by linking each assistant turn to its durable `chat.answer` audit event via `assistantMessageId` and `conversationId`.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend  
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Next.js App Router, Radix/vaul drawer primitives, Lucide icons  
**Storage**: PostgreSQL tables `conversations`, `messages`, and `audit_events`  
**Testing**: Vitest, Supertest, TypeScript compiler, Next.js production build  
**Target Platform**: Internal web dashboard  
**Project Type**: Web application with `backend/` and `frontend/`  
**Performance Goals**: History list and conversation drawer should load quickly for normal account history sizes; spec target is under 2 seconds for drawer open  
**Constraints**: Preserve account scoping, do not reintroduce debug UI into live chat, keep transport/orchestration/persistence boundaries explicit  
**Scale/Scope**: Account-level conversation browsing and per-turn debug inspection for existing chat usage

## Constitution Check

*GATE: Passed before implementation and re-checked after validation.*

- Approved spec exists at `/specs/011-chat-history/spec.md`.
- Backend work uses TDD-style targeted contract/integration coverage before final validation.
- Backend remains Node.js/Express and frontend remains React/Next.js.
- PostgreSQL remains the system of record; no new storage system added.
- No secret/config changes were introduced.
- Account scoping is preserved for history list/detail retrieval.
- Module seams remain explicit: chat history read path is separate from live chat flow, and sidebar remains navigation-focused.

## Project Structure

### Documentation (this feature)

```text
specs/011-chat-history/
├── plan.md
├── spec.md
├── tasks.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/app/http/routes/
├── src/app/server/
├── src/db/repositories/
├── src/modules/chat/services/
└── tests/

frontend/
├── app/account/[accountId]/[[...segments]]/
├── components/dashboard/
└── lib/
```

**Structure Decision**: Keep live chat transport in existing chat routes and service, add a focused history read service for conversation inspection, extend repositories only where persistence access is needed, and keep dashboard navigation/view composition in dedicated frontend components.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/chatRoutes.ts` serves live chat and history endpoints only.
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts` owns live chat writes and audit linkage; `backend/src/modules/chat/services/chatHistoryService.ts` owns read-side assembly for history list/detail payloads.
- **Domain Layer**: Retrieval diagnostics continue to be presented through `RetrievalInfoPresenter`; history uses the same presenter for durable debug rendering.
- **Persistence/Integration Layer**: `ConversationRepository`, `MessageRepository`, and `AuditEventRepository` remain DB-facing and are extended only for required reads.
- **Files Kept Small**: `frontend/components/dashboard/app-sidebar.tsx` remains navigation-focused; `frontend/components/dashboard/chat-view.tsx` remains live-chat-only.
- **Planned Extractions**: Dedicated `ChatHistoryView` component and `ChatHistoryService` keep history concerns out of existing live chat UI/service paths.
- **Required Refactor Stories**: None beyond the explicit history read seam and audit linkage landed in this feature.

## Validation Plan

- Backend TypeScript build: `npm run build` in `/Users/dm/code/hivec-chat-history/backend`
- Backend targeted tests: `npm test -- chat.contract.test.ts chat.integration.test.ts chat-service-streaming.test.ts` in `/Users/dm/code/hivec-chat-history/backend`
- Frontend production build: `npm run build` in `/Users/dm/code/hivec-chat-history/frontend`
