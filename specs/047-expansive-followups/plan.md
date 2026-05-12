# Implementation Plan: History-Aware Expansive Suggestions

**Branch**: `borohhov/exp-suggests` | **Date**: 2026-04-23 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/monterrey/specs/047-expansive-followups/spec.md)
**Input**: Feature specification from `/specs/047-expansive-followups/spec.md`

## Summary

Upgrade exploratory suggested questions from a flat turn-local list into
history-aware grouped suggestions. The backend will assemble recent
conversation intent plus grounded retrieval contexts into a focused suggestion
planner that returns distinct `deeper` and `broader` groups, while preserving
existing provenance and safety controls. The frontend will render grouped
suggestions consistently in authenticated and public chat, and docs will explain
how expansive suggestions behave.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives  
**Storage**: PostgreSQL 16 with `pgvector`; no new schema planned, reuse existing conversation history, retrieval contexts, and assistant-turn metadata  
**Testing**: Vitest unit, integration, and contract tests in `backend/tests`; existing frontend unit tests plus new UI coverage under `frontend/tests/unit/`  
**Target Platform**: Web application with authenticated dashboard chat and public chat surfaces  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve the current single-turn latency profile by reusing in-memory conversation history and existing grounded contexts, with one bounded suggestion-planning step per exploratory turn  
**Constraints**: Backend suggestion logic must remain grounded, `chatService.ts` must stay orchestration-focused, guided mode must stay more conservative than exploratory mode, existing suggested-question enable/count settings must keep working, runtime prompt assets belong in `backend/prompts/`, and no generated OpenAPI files are hand-edited  
**Scale/Scope**: Cross-cutting backend/frontend feature touching suggestion types, planning logic, chat payload shapes, chat rendering, history replay compatibility, and operator-facing docs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/047-expansive-followups/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks require failing backend tests before implementation changes.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; no storage changes required.
- LLM provider is GPT-5.2 for AI integrations. Pass; suggestion generation remains inside the existing backend LLM seam.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass; feature reuses existing workspace-scoped history and grounded contexts.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with focused suggestion-planning seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `chatService.ts` and chat thread UI files remain constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; new domain modules land before orchestration wiring expands.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass; chat suggestion response shapes are contract changes.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass; retrieval setting docs and `readme.md` will be reviewed and updated if needed.

## Project Structure

### Documentation (this feature)

```text
specs/047-expansive-followups/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── suggestion-groups-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── prompts/chat/
│   └── conversation-mode-suggestions.md
├── src/
│   ├── app/http/
│   │   ├── openapi/document.ts
│   │   └── presenters/chatPresenter.ts
│   ├── modules/chat/
│   │   ├── services/
│   │   │   ├── chatService.ts
│   │   │   ├── chatHistoryService.ts
│   │   │   ├── conversationModeExpansionService.ts
│   │   │   └── [new suggestion-planning helpers]
│   │   └── types/chatResponses.ts
│   └── modules/retrieval/
│       └── domain|services/
│           └── [existing rewrite/continuity helpers]
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── components/
│   ├── chat/public-chat-shell.tsx
│   └── dashboard/chat-message-thread.tsx
├── lib/
│   ├── api.ts
│   ├── chat-context.tsx
│   └── anonymous-chat-context.tsx
└── tests/unit/
```

**Structure Decision**: Keep transport ownership in existing chat presenters and
OpenAPI schemas, keep orchestration in `chatService.ts`, move history-aware
group planning into focused chat service modules, and keep frontend ownership in
shared API types plus reusable suggestion-rendering UI instead of duplicating
rendering rules across chat surfaces.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/openapi/document.ts` and `backend/src/app/http/presenters/chatPresenter.ts` own wire shapes only. Frontend `lib/api.ts` owns client-side response typing and stream parsing.
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts` coordinates retrieval, answer generation, and expansion application, but does not own history summarization, grouping, or duplicate classification details.
- **Domain Layer**: `backend/src/modules/chat/services/conversationModeExpansionService.ts` plus new focused helper modules own conversation intent extraction, grouped suggestion planning, and response parsing/filtering. Prompt policy remains under `backend/prompts/chat/`.
- **Persistence/Integration Layer**: Existing conversation/message repositories and history services continue to supply prior turns; no new repository layer is introduced.
- **Files Kept Small**: `chatService.ts`, `frontend/components/dashboard/chat-message-thread.tsx`, and `frontend/components/chat/public-chat-shell.tsx` must remain composition/rendering files rather than absorbing suggestion-planning rules.
- **Planned Extractions**:
  - grouped suggestion types in `backend/src/modules/chat/types/chatResponses.ts`
  - conversation intent snapshot builder under `backend/src/modules/chat/services/`
  - grouped suggestion planner/parser/filter helpers under `backend/src/modules/chat/services/`
  - reusable grouped suggestion renderer under `frontend/components/`
- **Required Refactor Stories**:
  - add grouped suggestion domain types before changing payload shapes
  - extract history-aware planning inputs before wiring `chatService.ts`
  - add shared frontend renderer before updating both chat surfaces

## Phase 0: Research

- Completed in [research.md](/Users/dm/conductor/workspaces/radioso/monterrey/specs/047-expansive-followups/research.md).

## Phase 1: Design & Contracts

- Suggestion group entities and conversation intent snapshots are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/monterrey/specs/047-expansive-followups/data-model.md).
- Payload and rendering expectations are captured in [suggestion-groups-contract.md](/Users/dm/conductor/workspaces/radioso/monterrey/specs/047-expansive-followups/contracts/suggestion-groups-contract.md).
- Verification scenarios for grouped rendering, omission behavior, and parity are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/monterrey/specs/047-expansive-followups/quickstart.md).
- Any backend chat response schema changes must be implemented in `backend/src/app/http/openapi/document.ts`; generated OpenAPI artifacts remain outputs only.
- The suggestion prompt remains owned by `backend/prompts/chat/conversation-mode-suggestions.md`.

## Phase 2: Implementation Strategy

1. Add failing backend tests for history-aware exploratory planning, grouped suggestion payloads, and omission behavior.
2. Extend chat suggestion types and contracts to support grouped `deeper` and `broader` suggestions with existing provenance fields.
3. Extract a focused history-aware planning seam that can assemble recent conversation context plus current retrieval contexts without bloating `chatService.ts`.
4. Update exploratory suggestion generation and filtering to produce grouped standalone suggestions while keeping guided and factual behavior stable.
5. Update authenticated and public chat rendering to show grouped suggestions consistently, then update docs and run targeted validation.

## Post-Design Constitution Check

- Backend TDD remains enforceable because grouped suggestion logic is isolated into dedicated seams with unit and integration coverage. Pass.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 constraints remain unchanged. Pass.
- HTTP contract changes are explicitly routed through `backend/src/app/http/openapi/document.ts`. Pass.
- Prompt asset ownership remains explicit under `backend/prompts/`. Pass.
- Ownership seams are improved rather than blurred: transport stays typed, orchestration stays slim, domain logic moves into focused suggestion-planning helpers, and frontend rendering is centralized in reusable UI. Pass.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
