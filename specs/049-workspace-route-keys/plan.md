# Implementation Plan: Workspace-First Dashboard URLs

**Branch**: `049-workspace-route-keys` | **Date**: 2026-04-25 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/harare-v1/specs/049-workspace-route-keys/spec.md)
**Input**: Feature specification from `/specs/049-workspace-route-keys/spec.md`

## Summary

Replace the authenticated dashboard's account-scoped path with a workspace-first canonical route keyed by a new short public workspace identifier while keeping internal workspace UUIDs unchanged. The implementation adds one focused backend seam for public route-key generation and signed-in resolution, updates frontend routing to canonicalize around `/w/[workspaceKey]/...`, and preserves backward compatibility by redirecting legacy `/account/[accountId]/...` links to the canonical workspace URL with deep-link state intact.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, `pg`, Zod, Pino, React 19, Next.js App Router, existing auth/workspace services  
**Storage**: PostgreSQL 16 with existing `workspaces`, `sessions`, `account_memberships`, and dashboard URL state in the browser  
**Testing**: Vitest unit tests, Supertest integration/contract tests, frontend Vitest unit tests, ESLint, Next.js production build  
**Target Platform**: Browser-based authenticated admin dashboard  
**Project Type**: Web application  
**Performance Goals**: Preserve existing dashboard navigation responsiveness while adding at most one lightweight authenticated workspace-resolution lookup for workspace-first entry  
**Constraints**: Keep workspace UUIDs internal, preserve multi-organization session behavior, preserve legacy dashboard links via redirects, avoid scattering account-resolution logic into page components  
**Scale/Scope**: Authenticated dashboard routing, workspace persistence, login/session restoration flows, and a small additive backend API surface for canonical route resolution

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

Result: Pass. The feature adds one additive workspace-public-key persistence field and one small authenticated resolution route, keeps backend/frontend responsibilities explicit, and requires README/OpenAPI updates because authenticated entry URLs and session restoration behavior change.

## Project Structure

### Documentation (this feature)

```text
specs/049-workspace-route-keys/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── workspace-route-resolution.md
├── tasks.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/openapi/document.ts
│   ├── app/http/routes/
│   │   ├── accountUserRoutes.ts
│   │   ├── authRoutes.ts
│   │   └── workspaceRoutes.ts
│   ├── app/server/
│   │   ├── dependencies.ts
│   │   └── types.ts
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/workspaceRepository.ts
│   └── modules/
│       ├── auth/services/
│       │   ├── authService.ts
│       │   └── workspaceSessionService.ts
│       └── workspace/services/workspaceService.ts
├── openapi.yaml
├── openapi.json
└── tests/
    ├── integration/
    ├── contract/
    └── unit/

frontend/
├── app/
│   ├── page.tsx
│   ├── account/[accountId]/[[...segments]]/page.tsx
│   └── w/[workspaceKey]/[[...segments]]/page.tsx
├── components/
│   ├── auth/
│   └── dashboard/
├── lib/
│   ├── api.ts
│   ├── auth-context.tsx
│   ├── dashboard-routes.ts
│   └── workspace-context.tsx
└── tests/unit/
```

**Structure Decision**: Keep route parsing/serialization centralized in `frontend/lib/dashboard-routes.ts`, use dedicated page entries for legacy and canonical dashboard routes, keep workspace/session restoration orchestration in `frontend/components/dashboard/dashboard-shell.tsx` and `frontend/lib/workspace-context.tsx`, and introduce one focused backend workspace-public-key seam in the workspace repository/service layer rather than embedding lookup rules in auth or route handlers.

## Module Ownership & Seams

- **Transport Layer**: `frontend/app/account/[accountId]/[[...segments]]/page.tsx` becomes legacy-route redirect handling only; `frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx` owns canonical route entry; backend Express routes own request parsing and response shaping only.
- **Orchestration Layer**: `frontend/components/dashboard/dashboard-shell.tsx`, `frontend/lib/workspace-context.tsx`, `backend/src/modules/auth/services/authService.ts`, and `backend/src/modules/auth/services/workspaceSessionService.ts` coordinate session/account/workspace restoration without owning persistence details.
- **Domain Layer**: `frontend/lib/dashboard-routes.ts` owns canonical URL construction and parsing; `backend/src/modules/workspace/services/workspaceService.ts` owns public route-key generation, resolution, and access validation decisions.
- **Persistence/Integration Layer**: `backend/src/db/repositories/workspaceRepository.ts` owns storage and lookup for workspace public route keys; frontend API clients in `frontend/lib/api.ts` own authenticated calls to the additive resolution endpoint.
- **Files Kept Small**: `frontend/app/account/[accountId]/[[...segments]]/page.tsx` must remain a legacy redirect transport seam, `frontend/app/w/[workspaceKey]/[[...segments]]/page.tsx` must remain route-entry only, `frontend/lib/dashboard-routes.ts` must not absorb auth/storage logic, and `backend/src/modules/auth/services/authService.ts` must not absorb workspace persistence details.
- **Planned Extractions**: Add a workspace public-route-key helper/domain seam under the workspace module and a typed frontend route-resolution helper in `frontend/lib/api.ts` instead of mixing lookup logic into UI components.
- **Required Refactor Stories**: None beyond the targeted route-entry split and workspace-public-key seam extraction.

## Complexity Tracking

No constitution violations or justified exceptions.
