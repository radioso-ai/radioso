# Implementation Plan: Conversational Unsupported Answers

**Branch**: `039-unsupported-answer-refine` | **Date**: 2026-04-15 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/madison-v1/specs/039-unsupported-answer-refine/spec.md)
**Input**: Feature specification from `/specs/039-unsupported-answer-refine/spec.md`

## Summary

Refine fully unsupported strict-mode answers and no-context refusals so they
sound conversational and, when possible, point toward adjacent grounded
material already retrieved for the turn. The implementation adds a focused
backend response-composition seam reused by live chat and eval replay, keeps
`chatService.ts` orchestration-only, preserves existing outcome semantics, and
updates operator-facing docs to describe the refined behavior.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22  
**Primary Dependencies**: Express, Zod, pg, OpenAI SDK, Pino, Vitest, Supertest  
**Storage**: PostgreSQL 16 with `pgvector`; no schema changes planned  
**Testing**: Vitest unit, integration, and contract suites  
**Target Platform**: Linux/macOS server runtime for backend API and worker  
**Project Type**: Web application with `backend/` and `frontend/`  
**Performance Goals**: Preserve existing chat latency profile; add at most one bounded wording-generation step on the same chat model path already used for unsupported notices  
**Constraints**: No generic model-knowledge fallback; no retrieval algorithm changes; `chatService.ts` remains orchestration-only; preserve existing answer outcome semantics and diagnostics  
**Scale/Scope**: Backend chat presentation/refusal behavior, eval replay parity, operator-facing retrieval docs, and regression coverage across no-context and fully unsupported strict-mode turns

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation.
  Pass; plan includes unit/integration red tests before implementation.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass;
  no schema work required.
- LLM provider is GPT-5.2 for AI integrations. Pass; reuse existing chat-model
  path through the provider registry.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass;
  no new configuration expected.
- Customer data handling and auditability are addressed where applicable. Pass;
  bounded retrieved-context inputs only, existing audit semantics preserved.
- Module boundaries between transport, orchestration, domain logic, and
  persistence are explicit. Pass; plan adds a focused composer module.
- Existing responsibility-limited files are identified, and the plan explains
  how new behavior avoids turning them into god objects. Pass; `chatService.ts`
  and retrieval services stay thin.
- If the current structure is unclear or target files are already too large, the
  plan adds architecture/refactor stories that must land before feature work in
  those areas. Pass; module extraction is included before orchestration wiring.
- If backend HTTP contracts change, the plan identifies updates required in
  `backend/src/app/http/openapi/document.ts` and treats generated outputs as
  derived. Pass; no HTTP contract change planned.
- If contracts, workflows, settings behavior, or user-visible functionality
  change, the plan identifies which docs must be updated in the same feature
  work. Pass; retrieval setting docs and root `readme.md` will be reviewed and
  updated if needed.

## Project Structure

### Documentation (this feature)

```text
specs/039-unsupported-answer-refine/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/server/
│   │   └── dependencies.ts
│   ├── modules/chat/services/
│   │   ├── chatService.ts
│   │   ├── answerSupportValidator.ts
│   │   ├── answerPresentationService.ts
│   │   ├── unsupportedNoticeGenerator.ts
│   │   └── [new grounded miss response composer module]
│   ├── modules/evals/services/
│   │   └── evalReplayService.ts
│   └── shared/infra/llm/
│       └── providerRegistry.ts
└── tests/
    ├── integration/chat.integration.test.ts
    ├── unit/chat-service-streaming.test.ts
    ├── unit/eval-replay-service.test.ts
    └── unit/[new composer tests]

frontend/
└── docs/settings-docs/retrieval/
    └── answer-support-policy.md
```

**Structure Decision**: Keep transport untouched and implement the feature in
backend domain services. `backend/src/modules/chat/services/chatService.ts`
continues to coordinate flow only. A new focused composer module owns
conversational no-context and fully unsupported strict-mode wording. Eval replay
reuses the same composer to keep operator tooling aligned with live behavior.

## Module Ownership & Seams

- **Transport Layer**: Existing Express routes and presenters under
  `backend/src/app/http/routes/` keep translating requests and responses only.
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`
  and `backend/src/modules/evals/services/evalReplayService.ts` coordinate
  retrieval, composition, persistence, and trace assembly.
- **Domain Layer**: `answerSupportValidator.ts` keeps support classification and
  segment replacement; a new grounded-miss response composer module owns the
  conversational wording for full unsupported and no-context outcomes.
- **Persistence/Integration Layer**: Existing repositories, audit service, and
  provider registry remain unchanged except for wiring the new composer.
- **Files Kept Small**: `chatService.ts`, retrieval pipeline services, route
  handlers, and frontend chat renderers must not absorb new wording-selection
  logic.
- **Planned Extractions**: Add a new composer interface plus deterministic and
  model-backed implementations so live chat, tests, and eval replay can share a
  bounded seam.
- **Required Refactor Stories**: None beyond the focused composer extraction
  needed to keep orchestration files responsibility-limited.

## Phase 0: Research

- Completed in [research.md](/Users/dm/conductor/workspaces/radioso/madison-v1/specs/039-unsupported-answer-refine/research.md).

## Phase 1: Design & Contracts

- Data model documented in [data-model.md](/Users/dm/conductor/workspaces/radioso/madison-v1/specs/039-unsupported-answer-refine/data-model.md).
- Quick verification scenarios documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/madison-v1/specs/039-unsupported-answer-refine/quickstart.md).
- No backend HTTP contract changes are planned, so no OpenAPI contract artifact
  changes are required.
- Agent context update will be run via `.specify/scripts/bash/update-agent-context.sh codex`.

## Phase 2: Implementation Strategy

1. Add failing backend tests that capture the refined no-context and fully
   unsupported strict-mode responses while preserving existing outcome metadata.
2. Implement the grounded-miss response composer with deterministic fallback and
   model-backed production wiring.
3. Wire chat service and eval replay through the composer without changing
   retrieval logic or outcome enums.
4. Update operator-facing docs and review whether the root `readme.md` needs a
   small wording adjustment for `answerSupportPolicy`.
5. Run targeted suites first, then broader regression validation before review.

## Post-Design Constitution Check

- The design keeps `chatService.ts` orchestration-only by moving wording logic
  into a focused module. Pass.
- No schema, secret, or HTTP contract changes are introduced. Pass.
- Documentation updates are explicitly in scope. Pass.
- Backend TDD remains required and is reflected in the task plan. Pass.

## Complexity Tracking

No constitution violations requiring justification.
