# Implementation Plan: Persistent Dashboard Links

**Branch**: `033-dashboard-deep-links` | **Date**: 2026-03-31 | **Spec**: [/Users/dm/conductor/workspaces/radioso/madrid/specs/033-dashboard-deep-links/spec.md](/Users/dm/conductor/workspaces/radioso/madrid/specs/033-dashboard-deep-links/spec.md)
**Input**: Feature specification from `/specs/033-dashboard-deep-links/spec.md`

## Summary

Add URL-backed dashboard route state for the revisit-worthy frontend surfaces that currently lose context: workspace restoration, document pagination and detail, history filter/page/detail, settings tabs and anchors, and connector selection. The implementation introduces one shared dashboard route-state contract and updates the affected views to consume normalized route state instead of relying on client-only local state.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24 for the frontend application
**Primary Dependencies**: React 19, Next.js 16 App Router, Radix UI primitives, Lucide icons  
**Storage**: Browser URL state plus existing browser local storage for workspace bootstrap  
**Testing**: Vitest unit tests, ESLint, Next.js production build  
**Target Platform**: Browser-based admin dashboard  
**Project Type**: Web application  
**Performance Goals**: Preserve current dashboard responsiveness while making supported locations revisit-able through the URL  
**Constraints**: No backend API changes, no expansion into transient UI state, preserve existing dashboard look and flow  
**Scale/Scope**: Four top-level dashboard sections with deep-link support added to Documents, History, Settings, and workspace restoration

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

Result: Pass. The feature is frontend-only, does not change backend contracts, and keeps routing/state ownership explicit.

## Project Structure

### Documentation (this feature)

```text
specs/033-dashboard-deep-links/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/
└── tests/

frontend/
├── app/account/[accountId]/[[...segments]]/page.tsx
├── components/dashboard/
│   ├── app-sidebar.tsx
│   ├── chat-history-view.tsx
│   ├── chat-view.tsx
│   ├── dashboard-shell.tsx
│   ├── documents-view.tsx
│   ├── first-run-experience.tsx
│   ├── connectors/connectors-tab.tsx
│   ├── documents/document-list.tsx
│   ├── history/history-list.tsx
│   ├── settings-view.tsx
│   └── settings/
│       ├── general-tab.tsx
│       ├── ingestion-settings-panel.tsx
│       ├── retrieval-settings-panel.tsx
│       └── settings-card.tsx
├── lib/dashboard-routes.ts
└── tests/unit/dashboard-routes.test.ts
```

**Structure Decision**: Keep the dashboard route entry in `frontend/app/account/[accountId]/[[...segments]]/page.tsx` as the transport seam, move URL parsing and serialization into `frontend/lib/dashboard-routes.ts`, and keep section views responsible only for rendering and translating supported user actions into normalized route updates.

## Module Ownership & Seams

- **Transport Layer**: `frontend/app/account/[accountId]/[[...segments]]/page.tsx` owns route entry and authenticated redirect handling.
- **Orchestration Layer**: `frontend/components/dashboard/dashboard-shell.tsx` owns workspace synchronization between the normalized route state and the workspace context.
- **Domain Layer**: `frontend/lib/dashboard-routes.ts` owns dashboard route-state parsing, normalization, and serialization.
- **Persistence/Integration Layer**: Existing frontend API clients and workspace local-storage bootstrap remain unchanged and continue to own data fetching and workspace-token persistence.
- **Files Kept Small**: `frontend/app/account/[accountId]/[[...segments]]/page.tsx` remains route-entry only, `frontend/components/dashboard/settings-view.tsx` remains settings orchestration only, and existing API clients do not absorb URL semantics.
- **Planned Extractions**: Introduce the shared route-state contract in `frontend/lib/dashboard-routes.ts` instead of duplicating query logic across Documents, History, Settings, and Connectors.
- **Required Refactor Stories**: None beyond the focused route-state extraction.

## Complexity Tracking

No constitution violations or justified exceptions.
