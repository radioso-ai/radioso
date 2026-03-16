# Implementation Plan: Conversational Subject Continuity

**Branch**: `012-subject-carry-forward` | **Date**: 2026-03-16 | **Spec**: [/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/spec.md](/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/spec.md)
**Input**: Feature specification from `/specs/012-subject-carry-forward/spec.md`

## Summary

Preserve subject continuity across context-dependent chat turns by introducing a retrieval-owned carried-subject state, comparing raw and subject-biased retrieval paths per turn, and reusing a subject only when current evidence converges on one normalized subject identity. Keep the user-visible message unchanged, keep `chatService` orchestration-only, and expose the decision metrics in retrieval diagnostics.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router  
**Storage**: PostgreSQL 16+ with `pgvector`; additive conversation/message diagnostics or conversation-scoped retrieval state only if required  
**Testing**: Vitest unit and integration suites, Supertest contract/integration coverage  
**Target Platform**: Linux server backend plus existing web admin UI  
**Project Type**: Web application with separate `backend/` and `frontend/` workspaces  
**Performance Goals**: Preserve current chat retrieval latency envelope while adding at most one additional retrieval pass for turns that are not self-contained  
**Constraints**: Keep raw user message unchanged; avoid regex- or pronoun-list-driven primary logic; preserve modular boundaries; degrade safely when evidence disagrees or remains ambiguous  
**Scale/Scope**: One feature slice across retrieval services, retrieval diagnostics, and backend tests; no broad conversational memory redesign in v1

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec.
- Backend work includes TDD with failing tests written before implementation.
- Stack remains Node.js for backend and React for frontend.
- Database is PostgreSQL with `pgvector` for embeddings and vector search.
- LLM provider is GPT-5.2 for AI integrations.
- Secrets and keys are managed via `.env` and `.env.example` is updated only if new configuration is required.
- Customer data handling remains inside current account-scoped chat/retrieval boundaries; no new sensitive document exposure is planned.
- Module boundaries remain explicit: routes transport-only, `chatService` orchestration-only, retrieval services own carry-forward logic and diagnostics, repositories own persistence.
- Existing responsibility-limited files are identified below, and the plan introduces focused retrieval-domain seams instead of expanding `chatService` or `promptBuilder`.
- No constitution violations are required for this feature.

## Project Structure

### Documentation (this feature)

```text
specs/012-subject-carry-forward/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chat-diagnostics.openapi.yaml
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   ├── db/repositories/
│   ├── modules/chat/services/
│   ├── modules/retrieval/domain/
│   ├── modules/retrieval/services/
│   └── shared/
└── tests/
    ├── contract/
    ├── integration/
    └── unit/

frontend/
├── app/
├── components/
└── lib/
```

**Structure Decision**: The feature stays primarily in `backend/src/modules/retrieval/` with additive orchestration wiring in `backend/src/modules/chat/services/chatService.ts` only if needed to persist conversation-scoped state. Retrieval decisions live in focused retrieval-domain services and types, while HTTP presenters and prompt assembly remain responsibility-limited. Frontend changes are not planned unless existing retrieval-info surfaces require additive diagnostic fields.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/chatRoutes.ts`, presenters under `backend/src/app/http/presenters/`
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- **Domain Layer**: new or refined retrieval-domain seams for subject identity normalization, carried-subject state, convergence evaluation, raw-vs-biased path comparison, and subject reuse outcomes
- **Persistence/Integration Layer**: existing message/conversation repositories if conversation-scoped subject state must persist; OpenAI rewrite gateway remains behind `QueryRewriteGateway`
- **Files Kept Small**: `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/promptBuilder.ts`, HTTP route/presenter files
- **Planned Extractions**:
  - `SubjectReference` and normalized identity types under `backend/src/modules/retrieval/domain/`
  - `SubjectContinuityService` or equivalent retrieval-owned seam for deciding `reused`, `newly_established`, `replaced`, `cleared`, `unresolved`
  - `SubjectConvergenceService` or equivalent seam for support-count/score-mass/margin evaluation
  - `RetrievalIntent` or equivalent structured input object for raw vs subject-biased rewrite/retrieval
- **Required Refactor Stories**: None required before feature work, but the plan must avoid growing `QueryRewriteService` into a god object by moving convergence and carried-subject decisions into focused services.

## Phase 0: Research Output

See [research.md](/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/research.md) for decisions on normalized subject identity, retrieval-state scope, disagreement handling, and v1 relation-shift boundaries.

## Phase 1: Design Output

- [data-model.md](/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/data-model.md) defines the retrieval-state and diagnostics entities.
- [contracts/chat-diagnostics.openapi.yaml](/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/contracts/chat-diagnostics.openapi.yaml) captures the additive diagnostics contract for chat retrieval info.
- [quickstart.md](/Users/dm/code/hivec-subject-carry-forward/specs/012-subject-carry-forward/quickstart.md) defines the validation path for implementation.

## Post-Design Constitution Check

- The design keeps the feature in backend retrieval modules and does not introduce cross-layer shortcuts.
- TDD remains explicit in `quickstart.md` and should be reflected in `tasks.md`.
- No new secrets or provider changes are introduced.
- `chatService` remains orchestration-only because subject continuity rules move into retrieval-owned seams.
- The design adds focused services instead of embedding hidden heuristics in prompt text, reranker glue, or transport layers.

## Complexity Tracking

No constitution violations or justified complexity exceptions are required.
