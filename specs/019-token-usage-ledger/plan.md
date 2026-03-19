# Implementation Plan: Model Token Usage Tracking & Account Summaries

**Branch**: `019-token-usage-ledger` | **Date**: 2026-03-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/019-token-usage-ledger/spec.md`

## Summary

Introduce immutable account-scoped usage events for every model-backed operation, update a daily rollup table on write, expose account-level daily/monthly summaries through a session-authenticated account endpoint, and extend chat history debug plus account-menu navigation so operators can inspect both per-turn usage and account-wide totals without expensive live aggregation.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 + React 19 + Next.js App Router (frontend)  
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Next.js, shadcn/ui, Radix UI primitives, Lucide icons  
**Storage**: PostgreSQL 16+ with `pgvector`; additive usage ledger and daily summary tables  
**Testing**: Vitest integration, contract, and unit tests on backend; frontend behavior validated through existing typed API/client flows  
**Target Platform**: Web application (browser + Node.js API server)  
**Project Type**: Web app with separate `backend/` and `frontend/` applications  
**Performance Goals**: Usage summary endpoint p95 under 2s for 12 months of history; write-path rollup update must add negligible overhead to chat/document-processing flows  
**Constraints**: Preserve history after workspace deletion, avoid scanning raw message/audit history for every usage query, keep workspace API tokens scoped to workspace resources only, and maintain TDD for backend changes  
**Scale/Scope**: Account-level summaries across all workspaces; usage captured for chat answer, rewrite, rerank, retrieval/query embeddings, and async document-processing embeddings

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec-First**: ✅ Approved spec exists at `specs/019-token-usage-ledger/spec.md`.
- **Backend TDD**: ✅ Plan requires failing backend tests before repository, service, route, and gateway instrumentation changes.
- **Stack Discipline**: ✅ Backend remains Node.js, frontend remains React/Next.js, PostgreSQL stays primary storage, and GPT-5.2 remains the provider family already in use.
- **Secrets/Config**: ✅ No new secrets expected. If any configuration becomes necessary for reconciliation/admin commands, `.env.example` must be updated.
- **UI Consistency**: ✅ Usage entry stays inside the existing bottom-left account menu and reuses the shared dashboard/sidebar design tokens.
- **Modularity**: ✅ New usage behavior is split into usage repositories + usage service + gateway capture seam. Existing route/service files remain responsibility-limited.
- **Responsibility-Limited Files**: ✅ `accountRoutes.ts` stays transport-only, `chatService.ts` stays orchestration-only, `chatHistoryService.ts` stays presenter-oriented, `app-sidebar.tsx` stays navigation-only, and `frontend/lib/api.ts` remains the client boundary.
- **Customer Data Protection**: ✅ Usage data is account-scoped, session-authenticated for summaries, and auditable. Workspace-token routes do not gain account-wide access.

No constitution violations. No complexity waivers required.

## Project Structure

### Documentation (this feature)

```text
specs/019-token-usage-ledger/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── usage-api.yaml
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/routes/
│   │   ├── accountRoutes.ts
│   │   └── chatRoutes.ts
│   ├── app/http/presenters/
│   │   └── chatPresenter.ts
│   ├── app/server/
│   │   ├── dependencies.ts
│   │   └── types.ts
│   ├── db/migrations/
│   │   └── 008_usage_tracking.sql
│   ├── db/repositories/
│   │   ├── messageRepository.ts
│   │   ├── usageEventRepository.ts
│   │   └── accountDailyUsageSummaryRepository.ts
│   └── modules/
│       ├── chat/services/
│       │   ├── chatService.ts
│       │   └── chatHistoryService.ts
│       ├── documents/services/
│       │   └── documentProcessingService.ts
│       ├── retrieval/services/
│       │   ├── embeddingService.ts
│       │   ├── queryRewriteService.ts
│       │   ├── rerankService.ts
│       │   └── retrievalPipelineService.ts
│       └── usage/services/
│           ├── usageCaptureService.ts
│           └── usageSummaryService.ts
└── tests/
    ├── contract/
    │   ├── account-usage.contract.test.ts
    │   └── chat.contract.test.ts
    ├── integration/
    │   ├── chat.integration.test.ts
    │   ├── account-usage.integration.test.ts
    │   └── persistence.integration.test.ts
    └── support/
        ├── fakes.ts
        └── testApp.ts

frontend/
├── app/account/[accountId]/[[...segments]]/page.tsx
├── components/dashboard/
│   ├── app-sidebar.tsx
│   ├── dashboard-shell.tsx
│   ├── chat-history-view.tsx
│   └── usage-view.tsx
└── lib/
    ├── api.ts
    └── dashboard-routes.ts
```

**Structure Decision**: Keep the existing backend/frontend split. Add focused usage persistence and summary services under `backend/src/modules/usage/` and `backend/src/db/repositories/`. Extend account routes for session-authenticated usage summaries, extend chat history presentation without turning it into an accounting engine, and add a dedicated account-level `usage` dashboard section surfaced from the existing account menu UI.

## Module Ownership & Seams

- **Transport Layer**: `accountRoutes.ts` for account usage summary endpoints; `chatRoutes.ts` and presenters only shape enriched chat responses/history payloads.
- **Orchestration Layer**: `chatService.ts`, `retrievalPipelineService.ts`, and `documentProcessingService.ts` continue orchestrating their workflows while delegating usage persistence to a dedicated usage capture service.
- **Domain Layer**: `usageCaptureService.ts` owns normalization of provider usage payloads, event identity, turn attribution, and rollup update policy. `usageSummaryService.ts` owns daily/monthly query behavior and reconciliation.
- **Persistence/Integration Layer**: `usageEventRepository.ts` and `accountDailyUsageSummaryRepository.ts` own SQL and transactions for immutable usage events and daily rollups. Existing OpenAI gateway classes surface provider usage to the usage layer.
- **Files Kept Small**: `chatService.ts`, `chatHistoryService.ts`, `accountRoutes.ts`, `app-sidebar.tsx`, and `frontend/lib/api.ts` must stay boundary-focused and avoid embedding rollup SQL or provider-specific parsing.
- **Planned Extractions**: New usage repositories and services; likely small usage-related presenter/types additions for chat history and account usage payloads.
- **Required Refactor Stories**: None before feature work. Existing seams are adequate once usage persistence is extracted instead of added to audit or chat-history internals.

## Complexity Tracking

No constitution violations to justify.
