# Implementation Plan: Settings UI Refresh

**Branch**: `[043-settings-ui-refresh]` | **Date**: 2026-04-19 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/043-settings-ui-refresh/spec.md`

## Summary

Refresh the admin settings experience by reorganizing the existing settings tabs around operator jobs to be done, introducing reusable in-tab section navigation, and keeping long-form save actions accessible without changing any backend contracts. The approved direction is a selective expansion of the current UI: stronger hierarchy and navigation inside the existing dark theme rather than a broad visual rewrite or new settings surface.

## Technical Context

**Language/Version**: TypeScript 5.7 with React 19 and Next.js 16  
**Primary Dependencies**: Next.js App Router, Lucide icons, existing Radix/shadcn UI primitives  
**Storage**: N/A for this feature; existing PostgreSQL-backed settings remain unchanged  
**Testing**: Vitest for frontend unit tests  
**Target Platform**: Responsive web dashboard for desktop and mobile
**Project Type**: Web application  
**Performance Goals**: Preserve current interaction performance and avoid introducing noticeable layout jank while navigating long settings pages  
**Constraints**: Must preserve current settings behavior and route-based deep-link support; must stay inside the established dark theme and design tokens; no backend API changes  
**Scale/Scope**: One dashboard surface (`Settings`) with four tabs and three major panel files

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

Result: PASS. This is a frontend-only feature. No backend contract, secrets, or persistence changes are planned. The current panel files are large enough that shared layout and tab metadata must be extracted before further UI changes are added.

## Project Structure

### Documentation (this feature)

```text
specs/043-settings-ui-refresh/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
frontend/
├── components/dashboard/
│   ├── settings-view.tsx
│   └── settings/
│       ├── general-tab.tsx
│       ├── ingestion-settings-panel.tsx
│       ├── retrieval-settings-panel.tsx
│       ├── settings-card.tsx
│       ├── settings-flow.tsx
│       ├── settings-docs.ts
│       ├── settings-options.ts
│       ├── settings-tab-shell.tsx           # new reusable tab chrome / section nav
│       └── settings-tab-metadata.ts         # new tab + section descriptors
└── tests/unit/
    └── settings-tab-metadata.test.ts        # new frontend coverage
```

**Structure Decision**: Keep `settings-view.tsx` responsible only for top-level tab selection and route sync. Extract reusable settings tab shell and metadata helpers under `frontend/components/dashboard/settings/` so `general-tab.tsx`, `ingestion-settings-panel.tsx`, and `retrieval-settings-panel.tsx` can remain focused on panel composition and their existing API interactions.

## Module Ownership & Seams

- **Transport Layer**: Next.js route handling and existing dashboard route parsing under `frontend/lib/dashboard-routes.ts` and settings route state consumption inside `settings-view.tsx`.
- **Orchestration Layer**: `settings-view.tsx` coordinates active tab routing; each panel file coordinates its own data loading and save flows.
- **Domain Layer**: Frontend-only settings IA metadata in `settings-tab-metadata.ts` describes tab summaries and sections; it is the source of truth for local settings navigation.
- **Persistence/Integration Layer**: Existing API clients in `frontend/lib/api.ts` remain unchanged and continue to own network persistence.
- **Files Kept Small**: `settings-view.tsx` must not absorb tab-specific section definitions; `settings-flow.tsx` must not become a general settings layout file; the three existing panel files must not duplicate the new settings navigation shell.
- **Planned Extractions**: Add `settings-tab-shell.tsx` and `settings-tab-metadata.ts`; enhance `settings-card.tsx` only where shared visual structure is needed.
- **Required Refactor Stories**: Extract the shared settings-shell/navigation seam before the panel refresh so the redesign is not implemented as copy-pasted layout code across each tab.

## Complexity Tracking

No constitution violations expected.
