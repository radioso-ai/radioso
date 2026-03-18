# Implementation Plan: Workspace Management (Rename & Delete)

**Branch**: `016-workspace-mgmt` | **Date**: 2026-03-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-workspace-mgmt/spec.md`

## Summary

Add workspace rename and delete capabilities. Rename requires a new repository method (`updateName`) and service method (`rename`), exposed via `PATCH /workspace/:id`. Delete leverages the existing `deleteById` repository method, adds service-level validation (prevent last-workspace deletion), and is exposed via `DELETE /workspace/:id`. Frontend gains a workspace name editor in settings and a "Danger Zone" card with confirmation dialog for deletion. Database cascade rules already handle child data cleanup on delete.

## Technical Context

**Language/Version**: Node.js (TypeScript) backend, React (TypeScript) frontend
**Primary Dependencies**: Express, Zod (validation), React, Tailwind CSS, shadcn/ui components
**Storage**: PostgreSQL with `pgvector` — workspaces table already has ON DELETE CASCADE on all child FK references
**Testing**: Vitest (backend integration/unit tests)
**Target Platform**: Web application (browser)
**Project Type**: Web (separate backend + frontend)
**Performance Goals**: Standard web app — rename/delete complete in <1s server-side
**Constraints**: Must be atomic; must prevent deletion of last workspace
**Scale/Scope**: Single-user account management; low-frequency operations

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Spec-First**: ✅ Spec exists at `specs/016-workspace-mgmt/spec.md`, approved before planning.
- **Backend TDD**: ✅ Plan includes test-first approach for service and route layers.
- **Stack Discipline**: ✅ Node.js backend, React frontend, PostgreSQL database. No LLM integration needed for this feature.
- **Secrets/Config**: ✅ No new secrets or configuration needed.
- **UI Consistency**: ✅ Danger Zone card will use existing design tokens (red accent via Tailwind's `destructive` variant from shadcn/ui).
- **Modularity**: ✅ Changes stay within existing module boundaries — repository, service, routes, frontend context. No new modules needed.
- **Responsibility-Limited Files**: ✅ `workspaceRoutes.ts` stays transport-only, `workspaceService.ts` stays orchestration, `workspaceRepository.ts` stays persistence. `settings-view.tsx` gains new sections but remains UI-only (delegates to context/API).
- **Customer Data Protection**: ✅ Workspace deletion cascades via DB constraints — complete data removal. Audit events recorded for both operations.

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/016-workspace-mgmt/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── workspace-api.yaml
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── db/repositories/
│   │   └── workspaceRepository.ts      # Add updateName()
│   ├── modules/workspace/services/
│   │   └── workspaceService.ts         # Add rename(), delete()
│   ├── app/http/routes/
│   │   └── workspaceRoutes.ts          # Add PATCH /:id, DELETE /:id
│   └── app/server/
│       └── dependencies.ts             # Wire audit into workspace service
└── tests/
    └── integration/
        └── workspace-mgmt.test.ts      # New test file

frontend/
├── lib/
│   ├── api.ts                          # Add rename(), delete() to workspaceApi
│   └── workspace-context.tsx           # Add renameWorkspace(), deleteWorkspace()
└── components/dashboard/
    └── settings-view.tsx               # Add workspace name editor + Danger Zone card
```

**Structure Decision**: Web application with existing backend/frontend split. All changes extend existing files within their current responsibility boundaries. One new test file.

## Module Ownership & Seams

- **Transport Layer**: `workspaceRoutes.ts` — adds `PATCH /workspace/:id` and `DELETE /workspace/:id`. Validates request params/body, delegates to service, returns response.
- **Orchestration Layer**: `workspaceService.ts` — adds `rename(workspaceId, accountId, newName)` and `delete(workspaceId, accountId)`. Validates ownership, enforces business rules (last-workspace check), records audit events.
- **Domain Layer**: Validation rules live in service (name length/format, last-workspace guard). No separate domain module needed for this scope.
- **Persistence Layer**: `workspaceRepository.ts` — adds `updateName(workspaceId, name)`. Existing `deleteById(workspaceId)` is reused. Database CASCADE handles child cleanup.
- **Files Kept Small**: `settings-view.tsx` (425 lines) — new sections add ~100 lines. Still well within acceptable size for a settings page.
- **Planned Extractions**: None needed. Changes are small and fit cleanly into existing modules.
- **Required Refactor Stories**: None. Existing structure is clean.

## Complexity Tracking

No constitution violations to justify.
