# Implementation Plan: Anonymous Chat Access

**Branch**: `020-anon-chat-access` | **Date**: 2026-03-20 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/020-anon-chat-access/spec.md`

## Summary

Allow unauthenticated users to chat with the workspace bot via a shareable public URL. Admins enable this through a toggle in General Settings. Anonymous users are distinguished by a browser cookie (UUID), and their conversations are stored alongside authenticated conversations with a distinct label. The chat UI reuses all existing components — only the page shell and data context differ.

## Technical Context

**Language/Version**: TypeScript (Node.js backend, Next.js 16 / React 19 frontend)
**Primary Dependencies**: Express, Next.js App Router, Shadcn/Radix UI, Tailwind CSS
**Storage**: PostgreSQL with `pgvector` (existing)
**Testing**: Vitest with Supertest (contract), unit, and integration test tiers
**Target Platform**: Web (server + SPA)
**Project Type**: Web application (backend + frontend)
**Performance Goals**: Anonymous chat response latency equivalent to authenticated chat
**Constraints**: Cookie-based session identity, no PII stored for anonymous users
**Scale/Scope**: Same concurrency as authenticated chat; no additional scaling concerns

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- ✅ Spec exists and is approved; no implementation without spec.
- ✅ Backend work includes TDD with failing tests written before implementation.
- ✅ Stack remains Node.js for backend and React for frontend.
- ✅ Database is PostgreSQL with `pgvector` for embeddings and vector search.
- ✅ LLM provider is GPT-5.2 for AI integrations.
- ✅ Secrets and keys are managed via `.env` and `.env.example` is updated.
- ✅ Customer data handling and auditability are addressed — anonymous users have no PII; audit events record anonymous chat activity.
- ✅ Module boundaries between transport, orchestration, domain logic, and persistence are explicit (see Module Ownership below).
- ✅ Existing responsibility-limited files identified — `chatRoutes.ts` stays authenticated-only; `settingsRoutes.ts` or new route handles general settings; `ChatService` is reused without absorbing auth logic.
- ✅ No files are too large to absorb the changes; no refactor stories required.

## Project Structure

### Documentation (this feature)

```text
specs/020-anon-chat-access/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── public-chat-api.yaml
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── http/
│   │   │   ├── middleware/
│   │   │   │   ├── resolveAnonymousSession.ts   # NEW — cookie + token resolution
│   │   │   │   └── anonymousRateLimiter.ts      # NEW — in-memory sliding window rate limiter
│   │   │   └── routes/
│   │   │       ├── publicChatRoutes.ts           # NEW — /api/v1/public/chat/:token
│   │   │       ├── settingsRoutes.ts             # MODIFIED — add general settings endpoints
│   │   │       └── index.ts                      # MODIFIED — mount new routes
│   │   └── server/
│   │       └── dependencies.ts                   # MODIFIED — wire new dependencies
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 009_anonymous_chat.sql            # NEW — schema changes
│   │   └── repositories/
│   │       ├── workspaceRepository.ts            # MODIFIED — findByAnonymousChatToken, update toggle
│   │       └── conversationRepository.ts         # MODIFIED — anonymous_session_id support
│   └── modules/
│       ├── chat/
│       │   └── services/
│       │       └── chatService.ts                # MODIFIED — accept anonymous context
│       └── workspace/
│           └── services/
│               └── workspaceService.ts           # MODIFIED — toggle + token generation
└── tests/
    ├── contract/
    │   └── public-chat.contract.test.ts          # NEW
    ├── integration/
    │   └── anonymous-chat.integration.test.ts    # NEW
    └── unit/
        ├── anonymous-session.test.ts             # NEW
        └── anonymous-rate-limiter.test.ts        # NEW

frontend/
├── app/
│   └── chat/
│       └── [token]/
│           ├── page.tsx                          # NEW — public chat page (no auth)
│           └── layout.tsx                        # NEW — minimal layout (no sidebar)
├── components/
│   └── dashboard/
│       ├── settings-view.tsx                     # MODIFIED — add anonymous chat toggle to General tab
│       └── chat-history-view.tsx                 # MODIFIED — label anonymous conversations
└── lib/
    ├── api.ts                                    # MODIFIED — add public chat API methods
    └── anonymous-chat-context.tsx                # NEW — context provider for anonymous chat
```

**Structure Decision**: Web application with separate backend (Express) and frontend (Next.js). New anonymous chat transport lives in `publicChatRoutes.ts` (transport layer). Anonymous session resolution is middleware (transport). Chat orchestration reuses existing `ChatService` (orchestration/domain). Data access extends existing repositories (persistence). Frontend adds a new route outside the authenticated layout with a dedicated context provider.

## Module Ownership & Seams

- **Transport Layer**: `publicChatRoutes.ts` (new) — handles HTTP for anonymous chat; `settingsRoutes.ts` (extended) — general settings endpoints. Neither contains business logic.
- **Orchestration Layer**: `ChatService` (existing) — coordinates chat flow. Modified minimally to accept anonymous session context instead of requiring `accountId`.
- **Domain Layer**: `workspaceService.ts` (extended) — owns toggle logic and token generation. Anonymous session identity is a simple UUID with no domain rules beyond generation. `anonymousRateLimiter.ts` (new) — in-memory sliding window counter, owns rate limit enforcement logic.
- **Persistence/Integration Layer**: `workspaceRepository.ts` and `conversationRepository.ts` (extended) — new columns, new query methods for anonymous lookups.
- **Files Kept Small**: `chatRoutes.ts` must NOT absorb anonymous routes. `requireApiToken.ts` must NOT be modified. `retrievalSettingsRepository.ts` must NOT absorb general settings.
- **Planned Extractions**: `resolveAnonymousSession.ts` middleware (new, focused). `anonymousRateLimiter.ts` middleware (new, focused). `publicChatRoutes.ts` (new, focused). `anonymous-chat-context.tsx` frontend context (new, focused).
- **Required Refactor Stories**: None — existing files are appropriately sized and the new modules introduce clean seams.

## Complexity Tracking

> No constitution violations. No complexity justifications needed.
