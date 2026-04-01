# Implementation Plan: Configurable Answer Support Policy

**Branch**: `034-answer-support-policy` | **Date**: 2026-04-01 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-support-policy/spec.md)
**Input**: Feature specification from `/specs/034-answer-support-policy/spec.md`

## Summary

Extend workspace retrieval settings with an answer-support policy (`strict`, `warn`, `off`), update the code-first settings API and retrieval settings UI to manage that policy, and evolve post-generation answer handling so strict mode uses a bounded generated non-verification notice in the user’s language while warn/off preserve the answer differently without changing support-detection heuristics.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 for backend, TypeScript 5.7 with React 19 and Next.js 16 for frontend  
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, Radix UI primitives  
**Storage**: PostgreSQL 16 with `pgvector`; additive retrieval-settings persistence for the workspace answer-support policy  
**Testing**: Vitest unit, integration, and contract tests in `backend/tests`; frontend verification through the existing retrieval settings flow and chat history/debug surfaces  
**Target Platform**: Web application with authenticated admin settings UI, authenticated chat, and anonymous/public chat routes  
**Project Type**: Web application with separate `backend/` and `frontend/` projects  
**Performance Goals**: Preserve the current retrieval and answer latency envelope by keeping policy handling in-process, with at most one bounded notice-generation step for strict-mode unsupported segments  
**Constraints**: Preserve current support-detection heuristics, keep `strict` as the default for backward compatibility, apply the same workspace policy to authenticated and anonymous/public chat, keep HTTP contracts code-first, and avoid pushing policy logic into route handlers or UI state  
**Scale/Scope**: Cross-cutting backend/frontend feature touching retrieval settings domain and persistence, settings HTTP schemas, chat answer presentation/validation policy, chat history/debug metadata, OpenAPI generation, and the retrieval settings UI

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/034-answer-support-policy/`.
- Backend work includes TDD with failing tests written before implementation. Pass: implementation tasks will begin with failing unit, contract, and integration tests for policy storage and per-mode answer handling.
- Stack remains Node.js for backend and React for frontend. Pass: TypeScript/Node backend and React/Next frontend only.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: additive retrieval-settings storage only; no database or retrieval stack replacement.
- LLM provider is GPT-5.2 for AI integrations. Pass: the bounded strict-mode notice generation stays on the existing GPT-5.2-backed provider seam.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secret type is expected.
- Customer data handling and auditability are addressed where applicable. Pass: policy remains workspace-scoped, diagnostics remain bounded, and chat history/debug surfaces continue to expose accountable answer outcomes.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with planned seams listed below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: settings routes, retrieval settings domain, `chatService.ts`, and the retrieval settings UI are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: a focused answer-support policy seam lands before orchestration wiring broadens.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: retrieval settings schemas must be updated there and generated artifacts refreshed.

## Project Structure

### Documentation (this feature)

```text
specs/034-answer-support-policy/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── retrieval-settings-contract.md
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
│   │           └── settingsRoutes.ts
│   ├── db/
│   │   └── repositories/
│   │       └── retrievalSettingsRepository.ts
│   └── modules/
│       ├── chat/
│       │   └── services/
│       │       ├── answerSupportValidationTypes.ts
│       │       ├── answerSupportValidator.ts
│       │       ├── assistantTurnOutcomeClassifier.ts
│       │       ├── chatHistoryService.ts
│       │       └── chatService.ts
│       └── settings/
│           ├── domain/
│           │   └── retrievalSettings.ts
│           └── services/
│               └── retrievalSettingsService.ts
└── tests/
    ├── contract/
    │   └── settings.contract.test.ts
    ├── integration/
    │   ├── chat.integration.test.ts
    │   └── public-chat.integration.test.ts
    └── unit/
        ├── retrieval-settings-and-chunking.test.ts
        ├── chat-service-streaming.test.ts
        ├── chat-history-service.test.ts
        └── answer-support-validator.test.ts

frontend/
├── components/
│   └── dashboard/
│       ├── chat-history-view.tsx
│       └── settings/
│           └── retrieval-settings-panel.tsx
└── lib/
    └── api.ts
```

**Structure Decision**: Keep transport and code-first schema changes in `backend/src/app/http/routes/settingsRoutes.ts` and `backend/src/app/http/openapi/document.ts`. Keep retrieval settings defaults, validation, and compatibility in `backend/src/modules/settings/domain/retrievalSettings.ts` with persistence in `backend/src/db/repositories/retrievalSettingsRepository.ts`. Keep chat orchestration in `backend/src/modules/chat/services/chatService.ts`, but move policy-specific answer handling into focused answer-support validation/policy helpers rather than embedding mode branches in routes or UI state. Keep frontend ownership in `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` and existing chat debug/history presentation components.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts` accepts and returns retrieval settings payloads only; `backend/src/app/http/openapi/document.ts` owns runtime request/response schemas; `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` and chat history/debug components own presentation and interaction only.
- **Orchestration Layer**: `backend/src/modules/settings/services/retrievalSettingsService.ts` loads and persists workspace settings without owning chat policy logic; `backend/src/modules/chat/services/chatService.ts` decides when validation runs and delegates policy-specific answer handling.
- **Domain Layer**: `backend/src/modules/settings/domain/retrievalSettings.ts` owns answer-support policy types, defaults, and validation; focused chat-domain helpers own policy application for `strict`, `warn`, and `off`, bounded strict-mode notice generation, and outcome classification.
- **Persistence/Integration Layer**: `backend/src/db/repositories/retrievalSettingsRepository.ts` owns backward-compatible settings storage; existing chat audit persistence remains the source of stored validation/debug metadata; the existing GPT-5.2 provider seam remains the integration point for bounded strict-mode notice generation.
- **Files Kept Small**: `settingsRoutes.ts` must not absorb answer-policy rules; `retrievalSettingsService.ts` must not absorb chat-domain branching; `chatService.ts` must remain orchestration-focused; `retrieval-settings-panel.tsx` must not become the source of truth for policy semantics.
- **Planned Extractions**:
  - answer-support policy enum/default helpers in retrieval settings domain
  - focused strict-mode unsupported-notice generation seam
  - policy-application helper that maps detected unsupported segments to strict/warn/off behavior
  - additive debug metadata mapping for active answer-support policy
- **Required Refactor Stories**:
  - extend retrieval settings domain and persistence before changing chat behavior
  - introduce focused answer-support policy helpers before wiring `chatService.ts`
  - update code-first schemas and frontend API types in the same slice as the settings payload expansion

## Phase 0: Research

See [research.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-support-policy/research.md) for the workspace-settings storage, strict-mode generated notice, warn/off policy behavior, and diagnostics decisions.

## Phase 1: Design & Contracts

- The workspace answer-support policy and validation diagnostics entities are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-support-policy/data-model.md).
- The retrieval settings contract changes are defined in [retrieval-settings-contract.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-support-policy/contracts/retrieval-settings-contract.md).
- Validation scenarios for settings saves, strict/warn/off behavior, and authenticated versus anonymous/public chat are documented in [quickstart.md](/Users/dm/conductor/workspaces/radioso/sacramento/specs/034-answer-support-policy/quickstart.md).

## Post-Design Constitution Check

- Backend TDD remains enforceable because settings validation, policy application, strict-mode notice generation, and chat outcome handling all have isolated seams for failing tests first.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 provider constraints remain unchanged.
- HTTP contract changes are explicitly routed through `backend/src/app/http/openapi/document.ts`, with generated OpenAPI files treated as outputs only.
- Ownership seams are improved rather than blurred: settings persistence stays in the settings module, answer-support policy remains in focused chat-domain helpers, and diagnostics/history presentation stays outside core policy logic.
- No constitution violations or exceptions are required.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
