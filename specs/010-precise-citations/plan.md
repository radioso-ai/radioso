# Implementation Plan: Precise Citation Placement

**Branch**: `010-precise-citations` | **Date**: 2026-03-16 | **Spec**: [/tmp/hivec-precise-citations/specs/010-precise-citations/spec.md](/tmp/hivec-precise-citations/specs/010-precise-citations/spec.md)
**Input**: Feature specification from `/specs/010-precise-citations/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Replace heuristic citation placement with backend-generated citation anchors and deterministic parsing. The model will cite retrieved context with an explicit anchor format, and the backend will parse those anchors into exact `answerSegments` and a validated citations list. Streaming will filter anchors out of chunks so the user never sees placeholder syntax, while completion uses the parsed placement metadata.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino  
**Storage**: PostgreSQL 16+ with `pgvector` (no schema changes expected)  
**Testing**: Vitest (unit, contract, integration)  
**Target Platform**: Linux server (backend), web (Next.js frontend)
**Project Type**: Web application (`backend/` + `frontend/`)  
**Performance Goals**: No measurable regression for chat response latency; parsing is linear in answer size  
**Constraints**: Preserve streaming UX; do not show raw citation-anchor syntax in the user-visible answer  
**Scale/Scope**: Per-request parsing only; bounded by typical chat response sizes

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

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── app/http/                 # Express routes + presenters (transport-only)
│   ├── modules/chat/             # Chat orchestration + presentation
│   └── modules/retrieval/        # Prompt building + retrieval pipeline
└── tests/

frontend/
└── components/dashboard/         # Chat UI renders answerSegments + citations

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: This feature is backend-led. Transport remains in `backend/src/app/http/*`. Orchestration remains in `backend/src/modules/chat/services/chatService.ts`. New deterministic citation-anchor parsing and streaming sanitization will live in a focused chat presentation module under `backend/src/modules/chat/services/` and will be invoked by `AnswerPresentationService` rather than adding more heuristics.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/presenters/chatPresenter.ts`, `backend/src/app/http/routes/*` (SSE + JSON payload wiring only)
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts` (coordinate retrieval + gateway + persistence; no parsing rules)
- **Domain Layer**: New citation-anchor parsing + validation service responsible for transforming raw model output into `answer`, `citations`, and `answerSegments`
- **Persistence/Integration Layer**: Existing message/document repositories and retrieval pipeline (unchanged)
- **Files Kept Small**: `backend/src/modules/chat/services/chatService.ts` and `backend/src/modules/chat/services/answerPresentationService.ts` must not accumulate prompt parsing or streaming text protocol handling
- **Planned Extractions**: Add a focused parser for `[[N]]` anchors and a streaming-safe text sanitizer that removes anchors without leaving broken fragments
- **Required Refactor Stories**: None expected; this is a contained extraction

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
