# Implementation Plan: Document List Polish

**Branch**: `[008-document-list-polish]` | **Date**: 2026-03-14 | **Spec**: [/tmp/radioso-document-list-polish/specs/008-document-list-polish/spec.md](/tmp/radioso-document-list-polish/specs/008-document-list-polish/spec.md)
**Input**: Feature specification from `/specs/008-document-list-polish/spec.md` (approved and binding per user instruction)

## Summary

Polish the documents list row layout and status treatment, add account-scoped permanent document deletion with explicit confirmation and clear failure handling, and make citation activation fail gracefully when a cited source has been removed. The solution keeps document routes transport-only, introduces a focused backend deletion service/repository seam, and keeps citation-failure feedback owned by chat citation rendering instead of global layout state.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI primitives, Lucide icons  
**Storage**: PostgreSQL 16+ (`documents`, `chunks` with `ON DELETE CASCADE`), no new storage systems  
**Testing**: Backend Vitest + Supertest with backend TDD; frontend lint and targeted manual verification from quickstart  
**Target Platform**: Browser dashboard and Node.js API service  
**Project Type**: web application (`backend/` + `frontend/`)  
**Performance Goals**: Keep list rendering responsive for existing pagination window and keep delete flow to a single API round-trip  
**Constraints**: No scope expansion into soft-delete/trash/restore, no changes to retrieval ranking or citation generation, and no route-layer business logic growth  
**Scale/Scope**: One documents list surface, one document route group, one document service/repository delete seam, one citation activation feedback path

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass (explicit user approval for this branch).
- Backend work includes TDD with failing tests written before implementation. Pass; deletion route/service/repository changes are test-first.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; no database technology change.
- LLM provider is GPT-5.2 for AI integrations. Pass; citation fallback is UI/API error handling only.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass; deletion remains account-scoped and auditable.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; dedicated deletion seam planned.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If structure is unclear or files are already too large, the plan adds architecture/refactor stories first. Pass; targeted extraction tasks are included before feature wiring.

## Project Structure

### Documentation (this feature)

```text
specs/008-document-list-polish/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── document-list-polish.openapi.yaml
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/routes/
│   │   └── documentRoutes.ts
│   ├── db/repositories/
│   │   └── documentRepository.ts
│   └── modules/documents/services/
│       ├── documentIngestionService.ts
│       └── documentDeletionService.ts (new)
└── tests/
    ├── contract/document.contract.test.ts
    ├── integration/persistence.integration.test.ts
    ├── unit/document-ingestion.test.ts
    └── support/{fakes.ts,testApp.ts}

frontend/
├── components/dashboard/
│   ├── documents-view.tsx
│   ├── document-status.tsx (new)
│   ├── chat-citations.tsx
│   └── chat-view.tsx
└── lib/
    └── api.ts
```

**Structure Decision**: Keep existing web-app split. `documentRoutes.ts` only validates/parses and delegates. Document deletion business behavior lives in a focused service under `modules/documents/services/`. Persistence delete ownership remains in `documentRepository.ts`. Documents list layout/status/delete UX remains in `documents-view.tsx` with status mapping extracted to a focused UI helper. Citation unavailable feedback stays inside `chat-citations.tsx` + chat open flow in `chat-view.tsx`, while `dashboard-shell.tsx` remains route orchestration only.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/documentRoutes.ts` (validate auth/params/body and delegate only)
- **Orchestration Layer**: `backend/src/modules/documents/services/documentDeletionService.ts` (new), `documentIngestionService.ts` (existing ingest/read/update only)
- **Domain Layer**: Document deletion rules (account ownership + not-found semantics), frontend status label/icon mapping for one-status display
- **Persistence/Integration Layer**: `backend/src/db/repositories/documentRepository.ts` delete + lookup methods; existing chunk cascade behavior in DB
- **Frontend Ownership**: `frontend/components/dashboard/documents-view.tsx` for list layout + delete confirmation UX; `frontend/components/dashboard/chat-citations.tsx` for citation activation fallback messaging; `frontend/lib/api.ts` for document list/get/delete adapters
- **Files Kept Small**: `documentRoutes.ts`, `dashboard-shell.tsx`, `chat-view.tsx`
- **Planned Extractions**: `documentDeletionService.ts` (backend seam), `document-status.tsx` (frontend status presentation seam)
- **Required Refactor Stories**: Complete seam extraction tasks before wiring delete endpoint and UI interactions

## Phase 0: Research Decisions

- Use hard delete with account-scoped repository predicate and 404 on missing/non-owned records.
- Reuse existing DB cascade (`chunks.document_id REFERENCES documents(id) ON DELETE CASCADE`) instead of adding manual chunk cleanup.
- Normalize row status to one icon + one plain-language label by mapping internal statuses in frontend status helper.
- Preserve chat context on citation failure by handling missing source in citation-click flow and surfacing inline unavailable feedback.

## Phase 1: Design Outputs

- `research.md` captures deletion semantics, status language mapping, citation fallback UX, and test strategy decisions.
- `data-model.md` defines document row view model, deletion command lifecycle, and citation availability state.
- `contracts/document-list-polish.openapi.yaml` defines delete endpoint behavior and citation-open error contract expectations.
- `quickstart.md` defines verification sequences for US1, US2, and US3.

## Implementation Strategy

1. Add backend deletion seam test-first (contract + unit/integration support), then implement repository/service/route wiring.
2. Update frontend API adapter and document list UI to support single-status rendering, delete control, and confirmation/failure states.
3. Add citation activation fallback flow that detects deleted documents and shows unavailable-source feedback without losing chat context.
4. Update OpenAPI docs and run targeted then broad validations.

## Testing Strategy

- Backend contract tests for `DELETE /api/v1/document/{documentId}` success, authorization, and ownership/not-found behavior.
- Backend unit tests for deletion service behavior (delete success, missing document handling, audit events).
- Backend integration tests to verify persistent removal and account scoping with real repositories.
- Frontend lint plus manual quickstart verification for layout overflow behavior, delete confirmation/cancel/failure, and citation unavailable handling.

## Post-Design Constitution Check

- Spec-first gate remains satisfied. Pass.
- Backend TDD is explicitly required in task ordering. Pass.
- Stack, storage, and provider discipline remain unchanged. Pass.
- Secrets hygiene unaffected. Pass.
- Customer data remains account-scoped with existing auth and audit channels. Pass.
- Transport/orchestration/domain/persistence boundaries stay explicit via new deletion seam and citation-owned UI feedback. Pass.
- No constitution violations require justification.

## Complexity Tracking

No constitution exceptions or justified violations are required for this plan.
