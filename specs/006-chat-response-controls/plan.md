# Implementation Plan: Chat Response Controls

**Branch**: `[006-chat-response-controls]` | **Date**: 2026-03-14 | **Spec**: [/Users/dm/code/radioso/specs/006-chat-response-controls/spec.md](/Users/dm/code/radioso/specs/006-chat-response-controls/spec.md)
**Input**: Feature specification from `/specs/006-chat-response-controls/spec.md`

## Summary

Add account-scoped chat response controls for warmth and closing-question behavior, and replace frontend-invented citation placement with backend-owned structured citation metadata. The design keeps citations optional at the response and rendering layers so citation markers can be disabled without changing grounding behavior or breaking streaming/non-streaming parity.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, pg, OpenAI SDK, Zod, Pino, Next.js App Router, Radix UI Slider/Hover Card  
**Storage**: PostgreSQL account-scoped settings in `retrieval_settings`; existing chat response payloads and SSE events  
**Testing**: Vitest + Supertest for backend TDD; frontend lint plus targeted UI verification for settings and citation rendering flows  
**Target Platform**: Web application with browser client and Node.js API  
**Project Type**: web application  
**Performance Goals**: Preserve current chat latency envelope, keep settings saves immediate, and maintain equivalent final output between streaming and non-streaming replies  
**Constraints**: Citations must remain optional, route handlers stay transport-only, retrieval remains the source-selection owner, and frontend rendering must not guess citation placement  
**Scale/Scope**: One settings surface, one chat answer pipeline, one citation-rendering path, and account-scoped behavior shared across all conversations

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; backend behavior changes are centered in settings, prompt construction, chat orchestration, and transport contracts with corresponding unit/integration/contract coverage.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; persistence changes are additive to the existing account settings model.
- LLM provider is GPT-5.2 for AI integrations. Pass; answer-generation behavior stays on the current provider path.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new external secret expected.
- Customer data handling and auditability are addressed where applicable. Pass; changes remain account-scoped and continue using existing audit/event patterns for settings and chat operations.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass; new response-preference and citation-assignment seams are planned rather than expanding route handlers.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; prompt composition and citation assignment will be extracted into focused modules if not already present.

## Project Structure

### Documentation (this feature)

```text
specs/006-chat-response-controls/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chat-response-controls.openapi.yaml
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── presenters/
│   │   └── routes/
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   └── modules/
│       ├── chat/services/
│       ├── retrieval/services/
│       └── settings/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── app/
├── components/dashboard/
├── components/ui/
└── lib/
```

**Structure Decision**: This is an existing web application with a clear `backend/` and `frontend/` split. Transport ownership stays in backend route/presenter files, orchestration stays in chat and settings services, domain behavior for prompt policy and citation assignment belongs in focused modules under `backend/src/modules`, persistence stays in repositories and migrations, API typing stays in `frontend/lib/api.ts`, settings UI stays in `frontend/components/dashboard/settings-view.tsx`, and citation rendering stays in `frontend/components/dashboard/chat-citations.tsx`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/presenters/chatPresenter.ts`
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts`, `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- **Domain Layer**: `backend/src/modules/retrieval/services/promptBuilder.ts` plus new focused seams for response instruction building and backend citation assignment/answer segmentation
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts`, `backend/src/db/migrations/*`, OpenAI gateways, vector search
- **Frontend Ownership**: `frontend/lib/api.ts`, `frontend/lib/chat-context.tsx`, `frontend/components/dashboard/settings-view.tsx`, `frontend/components/dashboard/chat-citations.tsx`
- **Files Kept Small**: `chatRoutes.ts`, `settingsRoutes.ts`, `chatPresenter.ts`, `chat-context.tsx`
- **Planned Extractions**: response-style instruction builder, answer-segmentation/citation-assignment mapper, optional chat response metadata type shared across JSON and SSE completion payloads
- **Required Refactor Stories**: None required before implementation, but citation-assignment logic must not be added to the existing frontend heuristic path

## Phase 0: Research Decisions

- Persist response controls in the existing account-scoped settings model rather than creating a second settings store.
- Treat “no trailing engagement questions” as a backend answer-policy concern, enforced through prompt instructions instead of frontend post-processing.
- Move citation placement from frontend heuristics to backend-produced structured metadata so repeated source references can be collapsed deliberately.
- Keep citation visibility optional in the contract and rendering layers so a present or future preference can hide markers without changing grounding internals.
- Preserve stream/non-stream parity by returning the same structured completion metadata in JSON responses and SSE completion events.

## Phase 1: Design Outputs

- `research.md` records the storage, prompt-policy, citation-mapping, compatibility, and testing decisions.
- `data-model.md` defines the account preference fields and structured answer metadata.
- `contracts/chat-response-controls.openapi.yaml` defines the settings and chat contract additions.
- `quickstart.md` captures the implementation and verification flow for backend, frontend, and streaming behavior.

## Implementation Strategy

1. Extend account-scoped settings to carry response warmth and citation-display preference, including validation, persistence, and API schema updates.
2. Introduce a focused backend response-instruction seam that converts settings into answer-generation rules, including the no-trailing-engagement-question policy.
3. Introduce a focused backend citation-assignment seam that returns structured answer metadata with optional citation markers and duplicate-collapsing rules.
4. Update chat transport to return the new optional structured metadata for both JSON and SSE completion payloads.
5. Update frontend API types, settings UI, chat state handling, and citation rendering to consume backend-owned metadata rather than positional heuristics.
6. Add backend TDD coverage first, then integration/contract coverage, then frontend verification for settings and citation rendering behavior.

## Testing Strategy

- Backend unit tests for response preference validation, prompt-policy generation, and citation deduplication/assignment rules
- Backend contract tests for updated settings and chat payload schemas with optional citations
- Backend integration tests for warmth persistence, no-engagement-question behavior, optional citation omission, and streaming/non-streaming parity
- Frontend verification for settings persistence, warmth slider behavior, and citation rendering with and without markers

## Post-Design Constitution Check

- Spec-first gate remains satisfied. Pass.
- Backend TDD scope is explicit in the testing strategy. Pass.
- Stack discipline remains unchanged. Pass.
- No new secret or provider changes are introduced. Pass.
- Customer data stays account-scoped and auditable through existing patterns. Pass.
- Transport, orchestration, domain, persistence, and presentation boundaries remain explicit. Pass.
- No constitution violations require justification.

## Complexity Tracking

No constitution exceptions or justified violations are required for this plan.
