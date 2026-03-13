# Implementation Plan: Chat Route Citations

**Branch**: `003-chat-route-citations` | **Date**: 2026-03-14 | **Spec**: [/private/tmp/hivec-chat-frontend-routes/specs/003-chat-route-citations/spec.md](/private/tmp/hivec-chat-frontend-routes/specs/003-chat-route-citations/spec.md)
**Input**: Feature specification from `/specs/003-chat-route-citations/spec.md`

## Summary

Replace local dashboard view state with account-scoped browser routes, keep document opening route-driven, and upgrade the chat surface to request streamed responses and render inline citation markers that navigate into the cited document. The plan keeps route parsing in route-level dashboard wrappers, keeps chat transport and SSE parsing inside a focused API client seam, and keeps citation rendering inside chat presentation logic. Existing backend chat and document HTTP contracts remain unchanged.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for the backend, TypeScript 5.7 with React 19 and Next.js 16 for the frontend  
**Primary Dependencies**: Next.js App Router, React 19, Radix UI primitives, Express, Zod, browser Fetch and ReadableStream APIs  
**Storage**: Browser `localStorage` for authenticated user bootstrap, in-memory client state for active chat session, backend account-scoped document and chat APIs, PostgreSQL unchanged  
**Testing**: Frontend lint/build validation, manual quickstart verification for routed dashboard flows, existing backend contract tests remain the regression safety net for chat streaming and document loading  
**Target Platform**: Authenticated browser-based dashboard on desktop and mobile  
**Project Type**: Web application with a separate `frontend/` Next.js workspace and `backend/` Express workspace  
**Performance Goals**: First streamed assistant text should become visible before the full answer completes, route transitions should not require full page reloads, and direct document routes should resolve within the existing document-loading experience  
**Constraints**: No account-crossing route leakage, no backend public contract change required for this feature, preserve the existing dark-theme design tokens, avoid adding more top-level state to the existing dashboard shell, and keep inline citations limited to data already available from the current chat response contract  
**Scale/Scope**: One authenticated account session at a time with a handful of primary dashboard routes and account-scoped documents

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. PASS
- Backend work includes TDD with failing tests written before implementation. PASS, because no backend behavior change is planned and existing backend contract coverage remains in place.
- Stack remains Node.js for backend and React for frontend. PASS
- Database is PostgreSQL with `pgvector` for embeddings and vector search. PASS, unchanged
- LLM provider is GPT-5.2 for AI integrations. PASS, unchanged
- Secrets and keys are managed via `.env` and `.env.example` is updated. PASS, unchanged
- Customer data handling and auditability are addressed where applicable. PASS, because account-scoped route validation and document-loading authorization remain enforced through existing backend APIs
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. PASS
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. PASS
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. PASS

## Project Structure

### Documentation (this feature)

```text
specs/003-chat-route-citations/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── openapi.yaml
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   └── app/http/
│       ├── presenters/
│       └── routes/
└── tests/
    └── contract/

frontend/
├── app/
│   ├── account/[accountId]/[[...segments]]/
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── auth/
│   ├── dashboard/
│   └── ui/
└── lib/
```

**Structure Decision**: Route ownership moves into `frontend/app/account/[accountId]/[[...segments]]/page.tsx` plus focused dashboard wrappers. The shared dashboard shell remains responsible only for layout and navigation chrome. Chat request and stream handling stays in `frontend/lib/api.ts` plus a small route helper seam. Chat session continuity lives in a dedicated client state module instead of route components. Document selection stays inside the documents view, driven by route parameters rather than sidebar state.

## Module Ownership & Seams

- **Transport Layer**: `frontend/app/page.tsx` and `frontend/app/account/[accountId]/[[...segments]]/page.tsx` translate route state into dashboard view state; backend routes and presenters remain unchanged transport adapters.
- **Orchestration Layer**: route-aware dashboard wrappers coordinate auth bootstrap, account validation, and view selection without owning chat rendering or document-fetch details.
- **Domain Layer**: route parsing, inline citation mapping, and chat session continuity live in focused frontend utility or context modules.
- **Persistence/Integration Layer**: `frontend/lib/api.ts` owns chat/document HTTP calls and SSE parsing; existing backend APIs and authorization continue to enforce account scoping.
- **Files Kept Small**: `frontend/components/dashboard/app-sidebar.tsx`, `frontend/components/dashboard/chat-view.tsx`, `frontend/components/dashboard/documents-view.tsx`, `frontend/lib/api.ts`, `frontend/app/page.tsx`
- **Planned Extractions**: account route helpers, route-aware dashboard shell, chat session provider, inline citation renderer, streamed chat API helper
- **Required Refactor Stories**: split current dashboard state ownership out of `frontend/components/dashboard/dashboard.tsx` before adding URL-backed navigation and streamed chat behavior

## Complexity Tracking

No constitution violations expected.
