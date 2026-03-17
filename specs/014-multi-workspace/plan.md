# Implementation Plan: Multi-Workspace Support

**Branch**: `014-multi-workspace` | **Date**: 2026-03-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/014-multi-workspace/spec.md`

## Summary

Introduce a `workspaces` entity so a single account can have multiple isolated data silos. All workspace-scoped data (documents, chunks, conversations, messages, retrieval settings, processing jobs) migrates from `account_id` to `workspace_id`. API tokens become per-workspace — the token implicitly identifies the workspace, so existing API contracts (document, chat, settings endpoints) remain unchanged. The frontend gains a workspace switcher below the logo in the sidebar.

## Technical Context

**Language/Version**: TypeScript (Node.js backend, Next.js frontend)
**Primary Dependencies**: Express, Next.js 14, React, shadcn/ui, Zod, pg (node-postgres), OpenAI SDK
**Storage**: PostgreSQL 16 with pgvector extension
**Testing**: Vitest (backend unit + integration)
**Target Platform**: Web (server + browser)
**Project Type**: Web application (backend/ + frontend/)
**Performance Goals**: No regression — workspace switching should be near-instant (no re-fetch of large datasets)
**Constraints**: Migration must be backward-compatible for existing single-workspace accounts
**Scale/Scope**: ~49 files reference `account_id`; ~15 service/repository methods need `accountId` → `workspaceId` parameter change

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- [x] Spec exists and is approved; no implementation without spec.
- [x] Backend work includes TDD with failing tests written before implementation.
- [x] Stack remains Node.js for backend and React for frontend.
- [x] Database is PostgreSQL with `pgvector` for embeddings and vector search.
- [x] LLM provider is GPT-5.2 for AI integrations (no changes to LLM layer).
- [x] Secrets and keys are managed via `.env` and `.env.example` is updated (no new secrets needed).
- [x] Customer data handling and auditability are addressed — audit_events gain `workspace_id` for traceability.
- [x] Module boundaries between transport, orchestration, domain logic, and persistence are explicit (see Module Ownership below).
- [x] Existing responsibility-limited files are identified — `authService.ts` stays auth-only; new `WorkspaceService` owns workspace logic.
- [x] No architecture/refactor stories needed — existing files are well-sized and modular.

**Post-Phase 1 Re-check**: All gates still pass. No new secrets, no LLM changes, no stack deviations. The new `WorkspaceService` and `WorkspaceRepository` follow existing patterns.

## Project Structure

### Documentation (this feature)

```text
specs/014-multi-workspace/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 research decisions
├── data-model.md        # Phase 1 data model
├── quickstart.md        # Phase 1 implementation guide
├── contracts/           # Phase 1 API contracts
│   └── api.yaml         # OpenAPI spec for new/changed endpoints
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   ├── http/
│   │   │   ├── middleware/
│   │   │   │   └── requireApiToken.ts      # Modified: sets workspaceId + accountId
│   │   │   └── routes/
│   │   │       ├── accountRoutes.ts         # Modified: workspace-scoped token endpoint
│   │   │       ├── workspaceRoutes.ts       # NEW: workspace CRUD routes
│   │   │       ├── chatRoutes.ts            # Modified: workspaceId from res.locals
│   │   │       ├── documentRoutes.ts        # Modified: workspaceId from res.locals
│   │   │       ├── settingsRoutes.ts        # Modified: workspaceId from res.locals
│   │   │       └── index.ts                 # Modified: mount workspace routes
│   │   └── server/
│   │       ├── dependencies.ts              # Modified: wire WorkspaceService + WorkspaceRepository
│   │       └── types.ts                     # Modified: add workspaceService to AppDependencies
│   ├── db/
│   │   ├── migrations/
│   │   │   └── 005_multi_workspace.sql      # NEW: workspaces table + data migration
│   │   └── repositories/
│   │       ├── workspaceRepository.ts       # NEW: workspace CRUD
│   │       ├── workspaceTokenRepository.ts  # NEW (replaces accountTokenRepository.ts)
│   │       ├── documentRepository.ts        # Modified: workspace_id queries
│   │       ├── chunkRepository.ts           # Modified: workspace_id queries
│   │       ├── conversationRepository.ts    # Modified: workspace_id queries
│   │       ├── messageRepository.ts         # Modified: workspace_id queries
│   │       ├── retrievalSettingsRepository.ts # Modified: workspace_id PK
│   │       ├── documentProcessingJobRepository.ts # Modified: workspace_id queries
│   │       └── auditEventRepository.ts      # Modified: add workspace_id column
│   └── modules/
│       ├── auth/services/authService.ts     # Modified: token methods use workspaceId; register creates default workspace
│       ├── workspace/                       # NEW module
│       │   └── services/
│       │       └── workspaceService.ts      # NEW: create, list, validate ownership
│       ├── chat/services/
│       │   ├── chatService.ts               # Modified: workspaceId param
│       │   └── chatHistoryService.ts        # Modified: workspaceId param
│       ├── documents/services/
│       │   ├── documentIngestionService.ts  # Modified: workspaceId param
│       │   ├── documentDeletionService.ts   # Modified: workspaceId param
│       │   ├── documentProcessingService.ts # Modified: workspaceId param
│       │   └── documentProcessingWorker.ts  # Modified: workspaceId from job
│       ├── retrieval/
│       │   ├── infra/vectorSearch.ts        # Modified: workspace_id filter
│       │   ├── infra/lexicalSearch.ts       # Modified: workspace_id filter
│       │   └── services/retrievalPipelineService.ts # Modified: workspaceId param
│       └── settings/services/
│           └── retrievalSettingsService.ts  # Modified: workspaceId param

frontend/
├── app/
│   └── account/[accountId]/[[...segments]]/
│       └── page.tsx                         # Modified: workspace bootstrap
├── components/
│   └── dashboard/
│       ├── workspace-switcher.tsx           # NEW: workspace dropdown
│       ├── app-sidebar.tsx                  # Modified: insert workspace switcher
│       ├── dashboard-shell.tsx              # Modified: pass workspaceId
│       ├── chat-view.tsx                    # Unchanged (uses API token)
│       ├── documents-view.tsx               # Unchanged (uses API token)
│       ├── settings-view.tsx                # Unchanged (uses API token)
│       └── token-view.tsx                   # Modified: shows workspace-scoped token
└── lib/
    ├── api.ts                               # Modified: per-workspace token storage, workspace API
    ├── auth-context.tsx                     # Modified: fetch workspaces on bootstrap
    ├── workspace-context.tsx                # NEW: active workspace state
    └── dashboard-routes.ts                  # Unchanged (URLs stay the same)
```

**Structure Decision**: Web application with `backend/` and `frontend/` directories. New workspace module at `backend/src/modules/workspace/`. New workspace context at `frontend/lib/workspace-context.tsx`. Follows existing module pattern (services/ under module directory).

## Module Ownership & Seams

- **Transport Layer**: `routes/workspaceRoutes.ts` (new), modified `accountRoutes.ts`, `documentRoutes.ts`, `chatRoutes.ts`, `settingsRoutes.ts`. Middleware `requireApiToken.ts` resolves workspace from token.
- **Orchestration Layer**: `WorkspaceService` (new) — coordinates workspace creation, listing, ownership validation. `AuthService` (modified) — delegates to `WorkspaceService` for default workspace creation during registration.
- **Domain Layer**: Workspace validation rules (name constraints, minimum-one-workspace invariant) live in `WorkspaceService`. No new domain primitives needed beyond the entity itself.
- **Persistence/Integration Layer**: `WorkspaceRepository` (new), `WorkspaceTokenRepository` (new, replaces `AccountTokenRepository`). All existing repositories modified to query by `workspace_id`.
- **Files Kept Small**:
  - `authService.ts` — must NOT absorb workspace CRUD. It calls `WorkspaceService.createDefault()` during registration and delegates token operations to `WorkspaceTokenRepository`.
  - `requireApiToken.ts` — stays thin. Token lookup returns `workspaceId`; middleware just sets `res.locals`.
  - `dependencies.ts` — gains two new wiring lines (WorkspaceRepository, WorkspaceService), no structural change.
- **Planned Extractions**:
  - `WorkspaceRepository` (new) — workspace CRUD persistence
  - `WorkspaceTokenRepository` (new) — replaces `AccountTokenRepository`
  - `WorkspaceService` (new) — workspace business logic
  - `workspace-context.tsx` (new) — frontend workspace state
  - `workspace-switcher.tsx` (new) — UI component
- **Required Refactor Stories**: None. All existing files are within reasonable size and responsibility bounds.

## Complexity Tracking

No constitution violations to justify. All gates pass cleanly.
