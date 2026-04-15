# Implementation Plan: Website Embed Widget

**Branch**: `040-website-embed-widget` | **Date**: 2026-04-15 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/rio-de-janeiro/specs/040-website-embed-widget/spec.md)
**Input**: Feature specification from `/specs/040-website-embed-widget/spec.md`

## Summary

Add a website-embed channel that lets operators copy a one-line install snippet and launch a Radioso-hosted iframe assistant on approved sites. The implementation should reuse the existing public-chat path and General Settings surface, adding only the minimum new seams required for domain allowlisting, short-lived embed session grants, a hosted iframe entry point, and a thin launcher script.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, Zod, `pg`, Pino, Next.js App Router, existing Radix/shadcn UI primitives, existing chat/public-chat frontend utilities  
**Storage**: PostgreSQL 16 with additive workspace columns; existing conversations/messages/audit events reused  
**Testing**: Vitest, Supertest, existing backend contract/integration/unit suites, frontend unit tests  
**Target Platform**: Web application with browser-installed script and hosted iframe surface  
**Project Type**: Web application (`backend/` + `frontend/`)  
**Performance Goals**: Launcher appears quickly after script load and first message remains within the same practical latency envelope as current public chat  
**Constraints**: Preserve transport/orchestration boundaries; introduce as few new seams and imports as possible; no privileged browser credentials; hosted iframe remains the trust boundary  
**Scale/Scope**: One new public channel built on the existing public-chat foundation, one new hosted embed surface, additive workspace settings only

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

**Gate result**: Pass. The approved spec exists, the feature fits the current stack, and the plan intentionally minimizes new seams by extending existing public-chat and settings flows with focused sibling files instead of speculative shared abstractions.

## Project Structure

### Documentation (this feature)

```text
specs/040-website-embed-widget/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── embed-http-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── middleware/
│   │   ├── openapi/
│   │   │   └── document.ts
│   │   └── routes/
│   │       ├── index.ts
│   │       ├── publicChatRoutes.ts
│   │       └── settingsRoutes.ts
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   │       └── workspaceRepository.ts
│   └── modules/
│       ├── chat/services/
│       └── settings/domain/
├── openapi.yaml
├── openapi.json
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── app/
│   ├── chat/[token]/
│   └── embed/[token]/
├── components/dashboard/settings/
├── lib/
│   ├── anonymous-chat-context.tsx
│   └── api.ts
└── tests/
    └── unit/
```

**Structure Decision**: Reuse the current backend settings and public-chat entry points, plus the current frontend public chat page and anonymous chat context, while adding only focused website-embed siblings where necessary. Transport stays in `backend/src/app/http/routes/*`; persistence stays in `backend/src/db/repositories/workspaceRepository.ts`; public-chat orchestration remains in existing chat services; operator UI remains in `frontend/components/dashboard/settings/general-tab.tsx`; the hosted embed surface lives under `frontend/app/embed/[token]/`; the launcher script should live in the frontend static/app layer rather than a new package.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/routes/publicChatRoutes.ts`, route mounting in `backend/src/app/http/routes/index.ts`, and the new embed bootstrap route file or focused extension alongside existing public-chat routes.
- **Orchestration Layer**: Existing `chatService`, `chatBootstrapService`, and a minimal embed-access service or helper responsible only for approved-origin validation plus short-lived grant issuance.
- **Domain Layer**: Existing assistant bootstrap and public-chat rules remain in current domain/services; website-embed configuration validation should live in a focused settings-domain file if current settings validation becomes too dense.
- **Persistence/Integration Layer**: `backend/src/db/repositories/workspaceRepository.ts` owns additive workspace embed fields; existing `auditService` and `audit_events` persistence own embed enable/deny event logging.
- **Files Kept Small**: `backend/src/app/http/routes/publicChatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/openapi/document.ts`, `frontend/components/dashboard/settings/general-tab.tsx`, and `frontend/lib/api.ts` must remain readable and transport/UI-focused.
- **Planned Extractions**: Prefer one focused embed-access helper/service and one focused embed route/middleware sibling rather than a generic public-access framework. Add one hosted embed page and one launcher script entry point. Avoid new shared abstractions unless implementation proves they are necessary.
- **Required Refactor Stories**: None required before implementation. The current structure already exposes a reusable public-chat foundation and settings surface. If implementation discovers `settingsRoutes.ts` or `general-tab.tsx` becoming unwieldy, extraction should remain local to website-embed concerns rather than broad platform refactors.

## Complexity Tracking

No constitution violations require justification at planning time.
