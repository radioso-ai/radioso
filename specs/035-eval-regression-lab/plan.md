# Implementation Plan: Eval Regression Lab

**Branch**: `035-eval-regression-lab` | **Date**: 2026-04-02 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/nashville-v1/specs/035-eval-regression-lab/spec.md)
**Input**: Feature specification from `/specs/035-eval-regression-lab/spec.md`

## Summary

Add a workspace-scoped eval regression lab that replays saved retrieval and conversation cases through the existing chat and retrieval pipeline, scores them primarily on deterministic Radioso-specific dimensions such as expected documents, citations, refusal behavior, and answer-support outcomes, persists bounded eval runs for comparison, and lets operators promote existing authenticated or anonymous conversation turns from chat history into eval datasets with review and redaction before save.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives, existing chat history and retrieval trace components  
**Storage**: PostgreSQL 16 with `pgvector`; additive eval datasets, eval cases, and eval runs persisted in PostgreSQL; existing chat history, messages, audit events, and retrieval trace metadata reused as import sources and replay diagnostics  
**Testing**: Vitest unit, contract, and integration tests under `backend/tests`; frontend component/state verification in the existing frontend test approach plus manual dashboard validation for dataset import and run comparison  
**Target Platform**: Web application with authenticated admin dashboard plus existing anonymous/public chat history support where authorized  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Keep single-case replay within the existing chat latency envelope, keep dataset runs bounded enough for operator use in-product, and make run comparison fast enough for same-session debugging rather than offline analytics only  
**Constraints**: Reuse existing chat and retrieval execution seams rather than reimplementing retrieval, keep scoring deterministic-first, keep eval artifacts bounded and redactable, avoid exact-answer coupling for most cases, preserve code-first HTTP contracts, and do not turn the feature into a generic analytics platform  
**Scale/Scope**: Cross-cutting backend/frontend feature spanning new eval persistence and services, chat history import flows, code-first API contracts, dashboard management UI, and run-comparison diagnostics built on top of existing retrieval trace and answer-support infrastructure

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved draft spec exists in `specs/035-eval-regression-lab/`.
- Backend work includes TDD with failing tests written before implementation. Pass: implementation will start with failing unit, contract, and integration coverage for dataset import, replay, scoring, and run comparison.
- Stack remains Node.js for backend and React for frontend. Pass: additive TypeScript/Node backend and React/Next frontend only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: additive PostgreSQL tables only; existing retrieval stack remains unchanged.
- LLM provider is GPT-5.2 for AI integrations. Pass: the first release is deterministic-first and does not require new model behavior; any later optional judge layer would stay on the existing provider seam.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secret class is expected for the MVP.
- Customer data handling and auditability are addressed where applicable. Pass with explicit requirements for bounded import review, redaction, workspace scoping, and no unrestricted storage of raw prompts or document bodies.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned eval domain seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `chatService.ts`, `chatHistoryService.ts`, retrieval trace services, and history UI surfaces remain bounded.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: dedicated eval services, repositories, and comparison helpers land before broad dashboard wiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: new eval and history-import endpoints must be modeled there and generated artifacts refreshed.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: eval workflow docs and operator quickstart artifacts are included in this feature documentation.

## Project Structure

### Documentation (this feature)

```text
specs/035-eval-regression-lab/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── eval-regression-lab-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/
│   │   └── http/
│   │       ├── openapi/
│   │       │   └── document.ts
│   │       └── routes/
│   │           ├── chatRoutes.ts
│   │           └── [new eval routes]
│   ├── db/
│   │   ├── migrations/
│   │   └── repositories/
│   │       ├── auditEventRepository.ts
│   │       ├── messageRepository.ts
│   │       ├── [new eval dataset repository]
│   │       └── [new eval run repository]
│   └── modules/
│       ├── chat/
│       │   └── services/
│       │       ├── chatHistoryService.ts
│       │       └── chatService.ts
│       ├── retrieval/
│       │   └── services/
│       │       ├── retrievalTracePresenter.ts
│       │       └── retrievalInfoPresenter.ts
│       └── [new eval module]/
│           ├── domain/
│           └── services/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── components/
│   └── dashboard/
│       ├── chat-history-view.tsx
│       ├── history/
│       └── [new eval components]
└── lib/
    └── api.ts
```

**Structure Decision**: Keep all new eval transport contracts and API schemas in dedicated backend eval routes plus `backend/src/app/http/openapi/document.ts`. Keep eval orchestration, scoring, replay, conversation import, and run comparison in a dedicated eval module instead of embedding them in chat services. Reuse `chatHistoryService.ts`, `messageRepository.ts`, `auditEventRepository.ts`, and existing retrieval trace presenters as source seams for importing and diagnosing cases. Keep dashboard ownership in focused eval components, while the existing history surface only launches the import flow.

## Module Ownership & Seams

- **Transport Layer**: dedicated eval HTTP routes own dataset, case, run, and comparison request/response handling; `backend/src/app/http/openapi/document.ts` owns the code-first API contract; frontend eval pages/components own rendering and interaction only.
- **Orchestration Layer**: a focused eval application service coordinates conversation import, replay execution through existing chat seams, scoring, persistence, and run comparison; `chatHistoryService.ts` continues to provide conversation data only.
- **Domain Layer**: focused eval-domain modules own case expectation rules, import normalization, replay input shaping, scoring dimensions, and run-comparison logic.
- **Persistence/Integration Layer**: dedicated eval repositories own PostgreSQL persistence for datasets, cases, and runs; existing chat history, messages, and audit-event repositories remain the source of historical conversations and stored retrieval metadata; existing chat/retrieval services remain the source of replay execution.
- **Files Kept Small**: `backend/src/modules/chat/services/chatService.ts` must not absorb eval orchestration; `backend/src/modules/chat/services/chatHistoryService.ts` must not become an eval repository; `frontend/components/dashboard/chat-history-view.tsx` must not become the owner of dataset CRUD or comparison logic; retrieval trace presenters must not absorb eval scoring rules.
- **Planned Extractions**:
  - eval dataset and eval case domain types
  - conversation import service with redaction/review shaping
  - replay executor that calls existing chat flows through a stable internal seam
  - deterministic scoring service for documents, citations, refusal, and answer-support outcomes
  - run comparison service that diffs scoring outputs and retrieval diagnostics
  - frontend eval dataset management and run-comparison components
- **Required Refactor Stories**:
  - define an internal replay seam before building scoring so eval does not duplicate chat orchestration
  - extract conversation-import normalization before wiring UI flows to avoid pushing import logic into history components
  - define bounded run diagnostics and comparison payloads before rendering the dashboard comparison UI

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/nashville-v1/specs/035-eval-regression-lab/research.md) for the key decisions on deterministic-first scoring, conversation-import boundaries, replay execution reuse, eval persistence shape, and the MVP split between regression lab functionality and out-of-scope analytics ideas.

## Phase 1: Design & Contracts

- The dataset, case, expectation, import draft, run, and comparison entities are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/nashville-v1/specs/035-eval-regression-lab/data-model.md).
- The additive backend endpoint shapes for dataset management, conversation import, replay execution, and run comparison are defined in [eval-regression-lab-contract.md](/Users/dm/conductor/workspaces/radioso/nashville-v1/specs/035-eval-regression-lab/contracts/eval-regression-lab-contract.md).
- The operator workflow for importing conversations, running datasets, and debugging regressions is captured in [quickstart.md](/Users/dm/conductor/workspaces/radioso/nashville-v1/specs/035-eval-regression-lab/quickstart.md).
- Backend HTTP contract ownership remains in `backend/src/app/http/openapi/document.ts`; generated `backend/openapi.yaml` and `backend/openapi.json` will be regenerated from code and never edited directly.

## MVP Delivery Order

1. Add the backend eval domain and persistence model for datasets, cases, runs, and bounded run diagnostics.
2. Land conversation-to-case import for authenticated history first, including preserved context selection, expectation seeding from retrieval trace/support diagnostics, and redaction review.
3. Reuse the existing chat/retrieval execution path to replay imported cases and score them on deterministic dimensions.
4. Add baseline-versus-current run comparison with per-case regression reasons.
5. Extend import support to anonymous/public chat history when authorized, and then add dashboard polish around dataset editing and comparison UX.

## Post-Design Constitution Check

- Backend TDD remains enforceable because import normalization, scoring, replay shaping, and run comparison all have isolated seams that can be tested before route wiring.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 constraints remain unchanged.
- Customer-data protections remain explicit through bounded import review, redaction, workspace scoping, and no unrestricted persistence of raw prompts or document bodies.
- Ownership seams improve rather than blur: chat services remain execution/orchestration seams, retrieval trace services remain diagnostic sources, and eval-specific rules live in a dedicated module.
- HTTP contract changes remain code-first and additive through `backend/src/app/http/openapi/document.ts`.
- No constitution violations or exceptions are required for this feature.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
