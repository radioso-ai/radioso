# Implementation Plan: Safe Markdown Chat Answers

**Branch**: `027-markdown-chat` | **Date**: 2026-03-25 | **Spec**: [/Users/dm/conductor/workspaces/radioso/juba-markdown-chat/specs/027-markdown-chat/spec.md](/Users/dm/conductor/workspaces/radioso/juba-markdown-chat/specs/027-markdown-chat/spec.md)
**Input**: Feature specification from `/Users/dm/conductor/workspaces/radioso/juba-markdown-chat/specs/027-markdown-chat/spec.md`

## Summary

Add a safe markdown renderer for assistant chat answers so structured responses are easier to scan without changing how citations are represented or opened. The feature stays in the shared frontend chat rendering layer and does not require backend contract or storage changes.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 22, React 19, Next.js 16  
**Primary Dependencies**: `react-markdown`, `remark-breaks`, existing Radix UI primitives, Lucide icons  
**Storage**: N/A; presentation-only feature with no new persistence  
**Testing**: Vitest with static React rendering assertions against assistant message content  
**Target Platform**: Web application  
**Project Type**: Web app with shared frontend chat surfaces  
**Performance Goals**: Match the current plain-text chat render path closely enough that markdown formatting does not create noticeable latency or streaming delay  
**Constraints**: Safe markdown subset only; no raw HTML execution; preserve citation markers as structured UI; keep user-authored markdown editing out of scope; no backend API or OpenAPI changes  
**Scale/Scope**: One shared markdown renderer used by live chat, anonymous chat, and chat history surfaces

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated.
- Customer data handling and auditability are addressed where applicable.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects.
- Backend HTTP contracts are unchanged, so no `backend/src/app/http/openapi/document.ts` or generated OpenAPI artifact updates are required.

## Project Structure

### Documentation (this feature)

```text
specs/027-markdown-chat/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
frontend/
├── app/chat/[token]/page.tsx
├── components/dashboard/chat-citations.tsx
├── components/dashboard/chat-markdown.tsx
├── components/dashboard/chat-message-thread.tsx
├── tests/unit/chat-markdown.test.tsx
├── tests/unit/chat-citations.test.tsx
├── package.json
└── vitest.config.ts
```

**Structure Decision**: Keep markdown parsing and safety rules in a new focused frontend component, keep citation markers and chat composition in `frontend/components/dashboard/chat-citations.tsx`, and let `frontend/components/dashboard/chat-message-thread.tsx` and `frontend/app/chat/[token]/page.tsx` continue acting as thin consumers of the shared assistant content renderer.

## Module Ownership & Seams

- **Transport Layer**: `frontend/app/chat/[token]/page.tsx`, `frontend/components/dashboard/chat-message-thread.tsx`, and existing dashboard views pass message data through without owning markdown policy.
- **Orchestration Layer**: `frontend/components/dashboard/chat-citations.tsx` coordinates segment rendering, linkified user text, and citation marker placement.
- **Domain Layer**: `frontend/components/dashboard/chat-markdown.tsx` owns the supported markdown subset, safe link handling, and presentation styling for assistant answer text.
- **Persistence/Integration Layer**: None for this feature; message content continues to arrive from existing chat APIs and is not re-modeled or persisted differently.
- **Files Kept Small**: `frontend/components/dashboard/chat-citations.tsx`, `frontend/components/dashboard/chat-message-thread.tsx`, and `frontend/app/chat/[token]/page.tsx` must stay focused on composition and layout, not markdown parsing policy.
- **Planned Extractions**: A dedicated assistant markdown renderer component with a small safe-link helper and markdown-specific styling.
- **Required Refactor Stories**: None. Current structure already has a shared assistant content path that can absorb this change without extra architecture cleanup.

## Complexity Tracking

No constitution violations require justification for this feature.
