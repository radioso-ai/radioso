# Implementation Plan: Answer Support Validator

**Branch**: `026-answer-support-validator` | **Date**: 2026-03-25 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/spec.md)
**Input**: Feature specification from `/specs/026-answer-support-validator/spec.md`

## Summary

Add backend-only post-generation answer support validation that treats citation anchors as inspectable support references, classifies normalized answer segments as supported, unsupported, or non-substantive, replaces unsupported substantive content with a safe unsupported notice before persistence or final delivery, downgrades persisted assistant-turn outcomes when replacements occur, and records validation diagnostics through the existing audit/history path. To satisfy validation-before-delivery for SSE, the streaming path will buffer the raw model answer, validate it, then emit only the validated answer text through the existing SSE event contract.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest  
**Storage**: PostgreSQL 16 with `pgvector` unchanged; additive audit-event metadata only, no schema change planned  
**Testing**: Vitest unit, integration, and contract suites under `backend/tests` with backend TDD first  
**Target Platform**: Node.js backend service powering authenticated and anonymous chat HTTP/SSE flows  
**Project Type**: Web application with separate `backend/` and `frontend/` projects, but this feature is backend-scoped  
**Performance Goals**: Preserve answer correctness first; keep validation linear in answer size, avoid extra database round-trips, and keep the added post-generation step bounded to one extra in-process validation pass without a second model call  
**Constraints**: No frontend-only safeguard, no hand-edited generated OpenAPI files, no raw unsupported text persisted or emitted in final JSON/SSE payloads, no route-level policy logic, and no database migration unless implementation discovery proves existing audit metadata insufficient  
**Scale/Scope**: Backend chat prompting, answer normalization, validation, assistant-turn outcome classification, audit metadata, history replay/debug contract, and regression coverage for mixed, supported, unsupported, and no-context answers

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: user directed delivery against the approved feature in `specs/026-answer-support-validator/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks require failing backend unit/integration/contract coverage before production edits.
- Stack remains Node.js for backend and React for frontend. Pass: backend-only TypeScript/Node changes.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no storage technology change.
- LLM provider is GPT-5.2 for AI integrations. Pass: the feature tightens prompt/validation behavior without changing provider selection.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass: unsupported raw text is removed before persistence, and diagnostics stay bounded to structured counts and dispositions.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned validator and outcome-classifier seams below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `chatService.ts`, `chatPresenter.ts`, and repositories remain narrow.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: validator and outcome classification are extracted before wiring orchestration.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: additive history-debug schema changes will be modeled in the code-first registry.

## Project Structure

### Documentation (this feature)

```text
specs/026-answer-support-validator/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── answer-support-debug-contract.md
├── checklists/
│   └── requirements.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── openapi/document.ts
│   │   └── presenters/chatPresenter.ts
│   ├── modules/
│   │   ├── audit/services/auditService.ts
│   │   ├── chat/services/
│   │   │   ├── answerPresentationService.ts
│   │   │   ├── chatHistoryService.ts
│   │   │   ├── chatService.ts
│   │   │   └── [new answer support validator / outcome classifier modules]
│   │   └── retrieval/services/promptBuilder.ts
│   └── db/repositories/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/
```

**Structure Decision**: Keep transport ownership in `backend/src/app/http/`, orchestration in `backend/src/modules/chat/services/chatService.ts`, prompt guidance in `backend/src/modules/retrieval/services/promptBuilder.ts`, and all support-validation and answer-outcome policy in new focused chat-domain modules under `backend/src/modules/chat/services/`. Reuse existing audit-event persistence and chat-history replay instead of adding a new store. Frontend code is not expected to change for this feature beyond consuming existing answer/history payloads.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/presenters/chatPresenter.ts`, and `backend/src/app/http/openapi/document.ts`
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`
- **Domain Layer**: `backend/src/modules/chat/services/answerPresentationService.ts` plus new focused modules for support validation, non-substantive detection, unsupported notice replacement, and assistant-turn outcome classification
- **Persistence/Integration Layer**: `backend/src/modules/audit/services/auditService.ts`, `backend/src/db/repositories/auditEventRepository.ts`, `backend/src/modules/chat/services/chatHistoryService.ts`, and existing LLM/retrieval integrations
- **Files Kept Small**: `backend/src/modules/chat/services/chatService.ts`, `backend/src/app/http/presenters/chatPresenter.ts`, `backend/src/modules/chat/services/chatHistoryService.ts`, and `backend/src/db/repositories/*.ts`
- **Planned Extractions**:
  - answer support validator service
  - answer segment classification helpers
  - assistant-turn outcome classifier
  - additive validation-debug mapping for chat history
- **Required Refactor Stories**:
  - Extract validation policy before extending `chatService.ts`
  - Add explicit outcome classification before modifying audit/history wiring

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/research.md) for decisions on evidence source, segment classification, unsupported notice behavior, and SSE enforcement.

## Phase 1: Design & Contracts

- Validation entities and persisted debug fields are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/data-model.md).
- Additive history-debug contract notes are defined in [answer-support-debug-contract.md](/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/contracts/answer-support-debug-contract.md).
- Implementation and verification flow is defined in [quickstart.md](/Users/dm/conductor/workspaces/radioso/validator-enforcement/specs/026-answer-support-validator/quickstart.md).
- Backend HTTP contract ownership remains in `backend/src/app/http/openapi/document.ts`; generated `backend/openapi.yaml` and `backend/openapi.json` will be regenerated from code.

## Post-Design Constitution Check

- Backend TDD remains mandatory and is front-loaded in the task order.
- No new secrets, persistence systems, or non-Node backend components are introduced.
- Responsibility seams remain explicit across transport, orchestration, domain validation, and persistence.
- The design removes unsupported text before persistence or final delivery, improving customer-data safety and auditability.
- OpenAPI ownership remains code-first and additive.
- No constitution violations or justified exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
