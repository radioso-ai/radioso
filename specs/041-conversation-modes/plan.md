# Implementation Plan: Conversation Modes

**Branch**: `041-conversation-modes` | **Date**: 2026-04-16 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/buffalo-v1/specs/041-conversation-modes/spec.md)
**Input**: Feature specification from `/specs/041-conversation-modes/spec.md`

## Summary

Add a workspace-scoped conversation mode (`factual`, `guided`,
`exploratory`) that shapes all grounded chat responses while keeping
`answerPolicy` as a separate trust boundary. The implementation extends
retrieval settings and settings APIs, adds a focused backend response-strategy
instruction seam plus a bounded grounded expansion planner/composer, preserves
`chatService.ts` as orchestration-only, exposes additive debug metadata, and
updates operator-facing docs.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, existing Radix/shadcn UI primitives  
**Storage**: PostgreSQL 16 with `pgvector`; additive retrieval-settings persistence inside existing `attribute_controls` JSON plus additive assistant-turn audit metadata  
**Testing**: Vitest unit, integration, and contract tests in `backend/tests`; frontend verification through existing retrieval settings and history/debug flows  
**Target Platform**: Web application with authenticated admin settings UI, authenticated chat, and anonymous/public chat routes  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve current chat latency envelope by reusing the existing retrieved context set and limiting mode-driven expansion to one bounded planning/composition step at most  
**Constraints**: `guided` is the default, explicit user brevity requests override optional expansion for the current turn, no second retrieval pass by default, no generic model fallback, `chatService.ts` remains orchestration-only, HTTP contracts stay code-first, and runtime prompt assets live under `backend/prompts/`  
**Scale/Scope**: Cross-cutting backend/frontend feature touching retrieval settings, prompt assembly, chat answer composition, public chat parity, history/debug metadata, code-first OpenAPI generation, settings UI, and operator docs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/041-conversation-modes/`.
- Backend work includes TDD with failing tests written before implementation. Pass: plan requires unit, integration, and contract red tests before implementation.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass; additive retrieval-settings and audit metadata only.
- LLM provider is GPT-5.2 for AI integrations. Pass; new mode-driven prompt and composition behavior stays on the existing provider seam.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass; no new secrets expected.
- Customer data handling and auditability are addressed where applicable. Pass; expansions use only grounded turn context, and audit/debug metadata remains additive and inspectable.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with new seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: settings routes, `promptBuilder.ts`, and `chatService.ts` are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass; focused extraction lands before orchestration wiring broadens.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: retrieval settings schemas and additive response/debug metadata touch the code-first registry.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: retrieval settings docs and the root `readme.md` must be reviewed and updated if the chat-behavior explanation changes.

## Project Structure

### Documentation (this feature)

```text
specs/041-conversation-modes/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── conversation-mode-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/
│   │   ├── openapi/document.ts
│   │   └── routes/
│   │       ├── settingsRoutes.ts
│   │       ├── chatRoutes.ts
│   │       └── publicChatRoutes.ts
│   ├── app/server/
│   │   └── dependencies.ts
│   ├── db/repositories/
│   │   └── retrievalSettingsRepository.ts
│   ├── modules/chat/services/
│   │   ├── chatService.ts
│   │   ├── chatHistoryService.ts
│   │   ├── answerSupportValidator.ts
│   │   ├── groundedMissResponseComposer.ts
│   │   └── [new conversation-mode planning/composition modules]
│   ├── modules/retrieval/services/
│   │   ├── promptBuilder.ts
│   │   ├── promptAssemblyStage.ts
│   │   └── retrievalPipelineStages.ts
│   └── modules/settings/
│       ├── domain/retrievalSettings.ts
│       └── services/retrievalSettingsService.ts
├── prompts/
│   └── chat/
│       └── [new conversation-mode prompt assets, if needed]
└── tests/
    ├── contract/
    │   ├── settings.contract.test.ts
    │   └── public-chat.contract.test.ts
    ├── integration/
    │   ├── chat.integration.test.ts
    │   └── anonymous-chat.integration.test.ts
    └── unit/
        ├── retrieval-settings-and-chunking.test.ts
        ├── chat-service-streaming.test.ts
        ├── chat-history-service.test.ts
        ├── chat-retrieval.domain.test.ts
        └── [new conversation-mode unit tests]

frontend/
├── components/dashboard/
│   ├── chat-history-view.tsx
│   └── settings/
│       ├── retrieval-settings-panel.tsx
│       └── settings-docs.ts
├── docs/settings-docs/retrieval/
│   └── [new conversation-mode doc]
└── lib/api.ts
```

**Structure Decision**: Keep workspace setting ownership in the existing
retrieval settings domain and repository. Keep request/response validation in
`settingsRoutes.ts` and `backend/src/app/http/openapi/document.ts`. Keep prompt
assembly responsible for passing conversation-mode context into generation, but
move strategy wording and post-answer expansion into focused chat/retrieval
domain modules rather than bloating `promptBuilder.ts` or `chatService.ts`. Keep
frontend ownership in the retrieval settings panel, shared API types, and
existing history/debug surfaces.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts`,
  `chatRoutes.ts`, and `publicChatRoutes.ts` translate requests and responses
  only; `backend/src/app/http/openapi/document.ts` owns runtime HTTP schemas;
  `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` and
  `chat-history-view.tsx` own presentation and interaction only.
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts`
  persists workspace settings; `backend/src/modules/chat/services/chatService.ts`
  coordinates retrieval, answer generation, validation, expansion composition,
  and persistence without owning mode-specific wording rules.
- **Domain Layer**: `backend/src/modules/settings/domain/retrievalSettings.ts`
  owns conversation-mode enum/default/validation; `promptBuilder.ts` or an
  extracted strategy-instruction helper owns mode-specific generation guidance;
  a new grounded expansion planner/composer owns focused and expansive
  continuations plus brevity-override behavior.
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts`
  owns additive storage inside retrieval settings; existing audit persistence
  remains the source of stored strategy metadata; provider registry and prompt
  loaders remain the integration point for GPT-backed behavior.
- **Files Kept Small**: `chatService.ts` must remain orchestration-only;
  `promptBuilder.ts` must not become the home for all exploration logic;
  settings routes and UI components must not encode mode semantics themselves.
- **Planned Extractions**:
  - conversation-mode enum/default helpers in retrieval settings domain
  - focused response-strategy instruction builder for answer generation
  - grounded expansion planner/composer that distinguishes `focused` and
    `expansive` continuations
  - additive metadata mapper for conversation-mode debug/history exposure
- **Required Refactor Stories**:
  - extend retrieval settings domain/repository/contracts before changing live
    chat behavior
  - introduce focused strategy and expansion seams before wiring `chatService.ts`
  - keep prompt assets under `backend/prompts/` if runtime instructions are
    extracted from code

## Phase 0: Research

- Completed in [research.md](/Users/dm/conductor/workspaces/radioso/buffalo-v1/specs/041-conversation-modes/research.md).

## Phase 1: Design & Contracts

- The conversation-mode, continuation, and strategy metadata entities are
  defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/buffalo-v1/specs/041-conversation-modes/data-model.md).
- Approved additive settings and history/debug contract notes are captured in
  [conversation-mode-contract.md](/Users/dm/conductor/workspaces/radioso/buffalo-v1/specs/041-conversation-modes/contracts/conversation-mode-contract.md).
- Verification scenarios for defaulting, supported-answer behavior, brevity
  override, support-policy interaction, and debug surfaces are documented in
  [quickstart.md](/Users/dm/conductor/workspaces/radioso/buffalo-v1/specs/041-conversation-modes/quickstart.md).
- Backend HTTP contract changes must be implemented in
  `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml` and
  `backend/openapi.json` remain generated outputs only.
- New runtime prompt assets, if introduced, belong under `backend/prompts/chat/`.
- Agent context update will be run via `.specify/scripts/bash/update-agent-context.sh codex`.

## Phase 2: Implementation Strategy

1. Extend retrieval settings defaults, validation, repository payloads, API
   types, and code-first OpenAPI schemas to carry `conversationMode`.
2. Add failing backend tests for settings defaulting/validation and for the
   supported, unsupported, no-context, and brevity-override behavior of all
   three modes.
3. Introduce a focused response-strategy instruction builder and a bounded
   grounded expansion planner/composer so `chatService.ts` stays orchestration-only.
4. Wire authenticated chat, public chat, eval/debug/history metadata, and
   streaming completion behavior through the new conversation-mode seams.
5. Update frontend settings UI, API types, history/debug rendering, and
   operator-facing docs, then run targeted validation followed by broader
   regression checks.

## Post-Design Constitution Check

- Backend TDD remains enforceable because settings validation, strategy
  instruction generation, expansion planning, and history/debug mapping all have
  isolated seams for red-green implementation. Pass.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 provider constraints
  remain unchanged. Pass.
- HTTP contract changes are explicitly routed through
  `backend/src/app/http/openapi/document.ts`, with generated OpenAPI files
  treated as outputs only. Pass.
- Prompt asset ownership is explicit: any runtime prompt files land under
  `backend/prompts/`. Pass.
- Ownership seams are improved rather than blurred: settings remain in the
  settings module, exploration planning remains in focused domain modules, and
  UI/history surfaces stay presentation-focused. Pass.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
