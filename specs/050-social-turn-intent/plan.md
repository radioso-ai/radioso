# Implementation Plan: Model-Level Social Turn Intent

**Branch**: `050-social-turn-intent` | **Date**: 2026-04-25 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/asuncion/specs/050-social-turn-intent/spec.md)
**Input**: Feature specification from `/specs/050-social-turn-intent/spec.md`

## Summary

Add a model-level response-intent signal to the existing query-interpretation
flow so chat can distinguish normal retrieval-backed turns from
`social_only` and `assistant_identity` turns. The implementation reuses the
existing interpretation model call, extracts a shared answer-instruction
builder so non-retrieval prompts keep assistant identity and workspace answer
guidance, routes social and identity turns away from retrieval and grounded-miss
fallback, preserves retrieval for mixed turns, removes regex-based identity
routing, records additive routing metadata, and updates the operator-facing
answer-instruction docs.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, existing prompt-loader and retrieval/chat service seams  
**Storage**: PostgreSQL 16 with existing conversations, messages, retrieval settings, and additive assistant-turn audit metadata only  
**Testing**: Vitest unit and integration tests in `backend/tests`; targeted frontend copy/doc verification for settings surfaces  
**Target Platform**: Web application with authenticated chat, public/anonymous chat, workspace settings, and existing history/audit diagnostics  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve one interpretation-model pass per retrieval-backed chat turn, avoid an extra classifier round-trip, and keep non-retrieval replies bounded to one normal answer generation call  
**Constraints**: No deterministic keyword or regex intent routing, no new public HTTP endpoint, no global weakening of `answerPolicy`, no duplication of answer-instruction logic, `chatService.ts` remains orchestration-focused, runtime prompts stay under `backend/prompts/`  
**Scale/Scope**: Cross-cutting backend feature touching query interpretation, chat orchestration, prompt assembly, audit metadata, targeted docs, and one assistant-settings helper copy string

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/050-social-turn-intent/`.
- Backend work includes TDD with failing tests written before implementation. Pass: tasks start with unit and integration red tests for each behavior slice.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: no storage change beyond additive metadata.
- LLM provider is GPT-5.2 for AI integrations. Pass: the feature reuses the existing interpretation and chat-generation provider seams.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secrets are planned.
- Customer data handling and auditability are addressed where applicable. Pass: routing metadata is additive and scoped to existing chat/audit records.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with new seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `chatService.ts` and `promptBuilder.ts` are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: shared answer-instruction and chat turn-intent seams land before orchestration wiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: no public HTTP contract change is planned.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: the answer-instruction setting docs and assistant-settings helper copy need updates because this behavior is user-visible.

## Project Structure

### Documentation (this feature)

```text
specs/050-social-turn-intent/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── social-turn-routing-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/server/dependencies.ts
│   ├── modules/chat/services/
│   │   ├── chatService.ts
│   │   ├── answerSupportValidator.ts
│   │   └── [new chat turn-intent service]
│   ├── modules/retrieval/domain/
│   │   └── retrievalPipelineTypes.ts
│   ├── modules/retrieval/services/
│   │   ├── queryRewriteService.ts
│   │   ├── queryInterpretationStage.ts
│   │   ├── retrievalPipelineStages.ts
│   │   ├── promptBuilder.ts
│   │   └── [new shared answer-instruction builder]
│   └── shared/infra/prompts/
├── prompts/
│   ├── retrieval/
│   │   ├── query-rewrite-system.md
│   │   └── query-rewrite-user.md
│   └── chat/
│       ├── assistant-identity-answer.md
│       └── [new social/identity prompt assets if needed]
└── tests/
    ├── integration/
    │   └── chat.integration.test.ts
    └── unit/
        ├── chat-retrieval.domain.test.ts
        ├── chat-service-streaming.test.ts
        ├── retrieval-pipeline-stages.test.ts
        └── [new focused unit tests if extraction warrants them]

frontend/
├── components/dashboard/settings/
│   └── workspace-assistant-channels-tab.tsx
└── docs/settings-docs/retrieval/
    └── custom-instruction.md

docs/
└── settings-docs/retrieval/custom-instruction.md
```

**Structure Decision**: Keep retrieval/query interpretation ownership in the
existing retrieval module. Keep chat orchestration in `chatService.ts`, but add
a focused chat turn-intent service so orchestration only coordinates the chosen
path. Extract the reusable answer-instruction logic from `promptBuilder.ts` so
both grounded and non-retrieval prompts use the same instruction source.
Limit frontend changes to settings docs and helper text, with no new control or
transport contract.

## Module Ownership & Seams

- **Transport Layer**: Existing chat routes and settings UI remain transport and
  presentation only; this feature adds no new public endpoint.
- **Orchestration Layer**: `backend/src/modules/chat/services/chatService.ts`
  continues to coordinate history loading, retrieval, answer generation, and
  persistence, but delegates intent interpretation and answer-instruction
  formatting.
- **Domain Layer**: `backend/src/modules/retrieval/services/queryRewriteService.ts`
  owns model-level response intent classification; a new shared
  answer-instruction builder owns the prompt blocks for assistant identity,
  workspace answer guidance, conversation mode, and response language; a new
  chat turn-intent service owns the decision about whether chat should skip
  retrieval based on the interpretation result.
- **Persistence/Integration Layer**: Existing repositories and audit services
  remain unchanged except for additive routing metadata; prompt templates remain
  under `backend/prompts/`.
- **Files Kept Small**: `chatService.ts` must not regain regex routing or inline
  prompt-text assembly; `promptBuilder.ts` must not become a second home for
  chat-only branching logic.
- **Planned Extractions**:
  - shared answer-instruction builder under `backend/src/modules/retrieval/services/`
  - focused chat turn-intent service under `backend/src/modules/chat/services/`
  - additive `responseIntent` type support under retrieval domain types
- **Required Refactor Stories**:
  - extract shared answer-instruction logic before wiring non-retrieval prompts
  - remove regex-based identity routing only after the model-level replacement
    path is live

## Phase 0: Research

- Completed in [research.md](/Users/dm/conductor/workspaces/radioso/asuncion/specs/050-social-turn-intent/research.md).

## Phase 1: Design & Contracts

- The routing, instruction, and diagnostic entities are documented in
  [data-model.md](/Users/dm/conductor/workspaces/radioso/asuncion/specs/050-social-turn-intent/data-model.md).
- Additive internal contract notes for `responseIntent` and stored routing
  metadata are documented in
  [social-turn-routing-contract.md](/Users/dm/conductor/workspaces/radioso/asuncion/specs/050-social-turn-intent/contracts/social-turn-routing-contract.md).
- Validation scenarios for social-only, mixed, identity-only, fallback, and
  diagnostics behavior are documented in
  [quickstart.md](/Users/dm/conductor/workspaces/radioso/asuncion/specs/050-social-turn-intent/quickstart.md).
- Runtime prompt assets introduced or revised for this feature belong under
  `backend/prompts/`.
- No code-first OpenAPI change is expected because the feature does not add or
  reshape a public HTTP contract.

## Phase 2: Implementation Strategy

1. Extend the existing interpretation prompt and structured result to emit an
   additive `responseIntent` field, defaulting safely to `retrieval`.
2. Extract a shared answer-instruction builder from the retrieval prompt path so
   non-retrieval prompts can reuse assistant identity, custom instruction,
   conversation mode, and response-language behavior.
3. Add a focused chat turn-intent service that runs the interpretation pass once
   for chat and decides whether retrieval should be skipped.
4. Route social-only and assistant-identity-only turns through non-retrieval
   prompts while preserving answer instructions and bypassing grounded-miss
   replacement.
5. Preserve retrieval-first behavior for mixed turns by reusing the same
   interpretation result when chat continues into the retrieval pipeline.
6. Record additive routing metadata and update the answer-instruction docs plus
   assistant-settings helper copy.

## Post-Design Constitution Check

- Backend TDD remains enforceable because intent parsing, shared instruction
  building, chat routing, and diagnostics each have isolated seams with focused
  tests. Pass.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 provider constraints
  remain unchanged. Pass.
- Prompt asset ownership stays explicit under `backend/prompts/`. Pass.
- No public HTTP contract change is planned, so the code-first OpenAPI registry
  remains untouched. Pass.
- The plan improves modularity by extracting shared instruction and intent
  routing seams rather than extending the existing regex path in
  `chatService.ts`. Pass.

## Complexity Tracking

No constitution violations or justified exceptions are required for this
feature.
