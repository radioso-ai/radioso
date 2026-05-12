# Implementation Plan: Website Embed Widget

**Branch**: `040-website-embed-widget` | **Date**: 2026-04-16 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/mogadishu/specs/040-website-embed-widget/spec.md)
**Input**: Feature specification from `/specs/040-website-embed-widget/spec.md`

## Summary

Deliver the approved website-embed follow-up scope for script-level overrides only: support a locale override for common widget copy plus assistant bootstrap locale hint, an initial open/collapsed state override, and a custom collapsed avatar image or GIF URL. The implementation must stay inside the existing website-embed/public-chat/settings seams, avoid new persisted settings, and preserve the existing hosted iframe trust boundary.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, `pg`, Pino, Next.js App Router, existing Radix/shadcn UI primitives, existing chat/public-chat frontend utilities  
**Storage**: PostgreSQL 16 unchanged for this scope; existing conversations/messages/audit events reused with no new persisted override fields  
**Testing**: Vitest, existing backend/frontend focused unit or contract suites as applicable  
**Target Platform**: Web application with browser-installed script and hosted iframe surface  
**Project Type**: Web application (`backend/` + `frontend/`)  
**Performance Goals**: Preserve current launcher and bootstrap latency characteristics while adding only lightweight script parsing and avatar fallback behavior  
**Constraints**: Preserve transport/orchestration boundaries; introduce no new persisted override settings unless strictly necessary; no privileged browser credentials; hosted iframe remains the trust boundary  
**Scale/Scope**: Incremental enhancement to the existing website-embed channel and public-chat bootstrap path only

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
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work.

**Gate result**: Pass. The approved spec exists, the scope is intentionally narrow, and the change can remain within existing website-embed/public-chat/settings ownership seams without new persistence or architecture expansion.

## Project Structure

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/routes/
│   │   └── settingsRoutes.ts
│   └── modules/chat/services/
│       └── chatLocale.ts

frontend/
├── app/embed/[token]/
├── components/chat/
├── components/dashboard/settings/
├── lib/
│   ├── anonymous-chat-context.tsx
│   ├── api.ts
│   └── embed-widget.ts
├── public/
│   └── radioso-embed.js
└── tests/unit/
```

**Structure Decision**: Reuse the existing embed script, hosted iframe shell, anonymous chat context, and settings copy surface. Any new behavior should be implemented as script-parsed attributes and request-scoped locale propagation rather than new workspace fields or broader embed abstractions.

## Module Ownership & Seams

- **Transport Layer**: `frontend/public/radioso-embed.js` owns script attribute parsing and launcher rendering only; `frontend/app/embed/[token]/page.tsx` and `frontend/components/chat/embedded-chat-frame.tsx` own iframe bootstrap UX only.
- **Orchestration Layer**: `frontend/lib/anonymous-chat-context.tsx` remains the single public-chat bootstrap client path and should absorb request-scoped locale override support without forking chat behavior.
- **Settings/UI Layer**: `frontend/components/dashboard/settings/general-tab.tsx` and `frontend/lib/embed-widget.ts` own snippet generation and operator-facing documentation for optional attributes only; they must not add persisted per-site settings.
- **Backend Layer**: `backend/src/app/http/routes/settingsRoutes.ts` may continue generating the default snippet, but should not gain new persisted fields for script-level overrides. Existing locale validation in `backend/src/modules/chat/services/chatLocale.ts` remains the canonical backend gate for request-scoped locale hints.
- **Files Kept Small**: `frontend/public/radioso-embed.js`, `frontend/lib/anonymous-chat-context.tsx`, `frontend/lib/embed-widget.ts`, and `frontend/components/dashboard/settings/general-tab.tsx` must remain responsibility-limited.
- **Required Refactor Stories**: None. The scope fits existing seams directly.

## Complexity Tracking

No constitution violations require justification at planning time.
