# Implementation Plan: Account Multi-User Access

**Branch**: `036-account-users` | **Date**: 2026-04-09 | **Spec**: [/Users/dm/conductor/workspaces/radioso/santo-domingo-v2/specs/036-account-users/spec.md](/Users/dm/conductor/workspaces/radioso/santo-domingo-v2/specs/036-account-users/spec.md)
**Input**: Feature specification from `/specs/036-account-users/spec.md`

## Summary

Introduce real user identity and account membership to replace the current single-user account model, add account invitation flows plus a dashboard Users page, and keep workspace access uniform by validating active membership through a dedicated authorization seam rather than direct workspace ownership checks.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, `pg`, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives, Lucide icons  
**Storage**: PostgreSQL 16 with additive `users`, `account_memberships`, and `account_invitations` tables; existing `accounts`, `workspaces`, `sessions`, and `workspace_tokens` remain in use  
**Testing**: Vitest unit, contract, and integration suites for backend; Vitest unit tests for frontend  
**Target Platform**: Web application with Express API and Next.js frontend  
**Project Type**: Web application with separate `backend/` and `frontend/` packages  
**Performance Goals**: Preserve current dashboard responsiveness; invitation management and workspace bootstrap should remain single-request flows on cached session data  
**Constraints**: Backend TDD is mandatory; OpenAPI must remain code-first; admin UI must stay on the existing dark theme; no differentiated permissions in this release  
**Scale/Scope**: Existing single-user accounts must migrate in place; each account can now support multiple active users and pending invitations without changing workspace data boundaries

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Planned and required for auth, account-user, and workspace-access changes.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; feature adds relational tables only.
- LLM provider is GPT-5.2 for AI integrations. Pass; no LLM surface changes.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass; invitation lifecycle and account-user changes will emit audit events.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with the new account-access and invitation seams.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; `authService.ts` and `workspaceService.ts` will delegate new behavior to focused services.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass; update `frontend/README.md`.

## Project Structure

### Documentation (this feature)

```text
specs/036-account-users/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── account-users-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── middleware/
│   │   ├── openapi/
│   │   └── routes/
│   ├── app/server/
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   ├── modules/
│   │   ├── account/
│   │   ├── auth/
│   │   └── workspace/
│   └── shared/
├── openapi.yaml
├── openapi.json
├── scripts/generateOpenApi.ts
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── app/
├── components/
│   ├── auth/
│   └── dashboard/
├── lib/
└── tests/
    └── unit/
```

**Structure Decision**: Keep transport in Express route and middleware files under `backend/src/app/http`, keep authentication bootstrap in `backend/src/modules/auth/services/authService.ts`, add a focused account-access module under `backend/src/modules/account/` for invitation and membership rules, preserve workspace orchestration in `backend/src/modules/workspace/services/workspaceService.ts`, and keep the Users page/UI state in frontend dashboard/auth components plus `frontend/lib` API/context helpers.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/authRoutes.ts`, new account-user routes, `requireSession.ts`, `requireWorkspaceSession.ts`, and `frontend/app/account/[accountId]/[[...segments]]/page.tsx`
- **Orchestration Layer**: `backend/src/modules/auth/services/authService.ts`, new `backend/src/modules/account/services/accountAccessService.ts`, new `backend/src/modules/account/services/accountInvitationService.ts`, and `backend/src/modules/workspace/services/workspaceService.ts`
- **Domain Layer**: auth primitives, invitation lifecycle/status rules, account-membership selection, and workspace-access resolution rules encapsulated in the new account module
- **Persistence/Integration Layer**: new repositories for users, account memberships, and account invitations; existing workspace/session/workspace-token repositories; generated OpenAPI artifacts
- **Files Kept Small**: `backend/src/app/http/routes/authRoutes.ts`, `backend/src/app/http/routes/workspaceRoutes.ts`, `backend/src/app/http/middleware/requireSession.ts`, `frontend/components/dashboard/app-sidebar.tsx`, and `frontend/lib/auth-context.tsx`
- **Planned Extractions**: `UserRepository`, `AccountMembershipRepository`, `AccountInvitationRepository`, `AccountAccessService`, `AccountInvitationService`, and a dedicated frontend Users view/API surface
- **Required Refactor Stories**: Separate user identity from account context inside auth/session bootstrap before layering invitation or Users-page behavior onto the dashboard

## Complexity Tracking

No constitution violations expected.
