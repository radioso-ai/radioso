# Implementation Plan: Chat Execution Classes

**Branch**: `044-async-chat-jobs` | **Date**: 2026-04-22 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/provo/specs/044-async-chat-jobs/spec.md)
**Input**: Feature specification from `/specs/044-async-chat-jobs/spec.md`

## Summary

Codify Radioso's assistant execution model as two explicit classes while shipping only the interactive side for the covered workflows in this feature. The implementation keeps authenticated chat, public chat, embedded chat, and bootstrap greeting on their current inline paths, adds a focused execution-policy seam so the classification lives in code instead of tribal knowledge, adds guardrail tests that prevent silent queue-backed fallback for normal chat, and updates operator-facing documentation so enterprise reviewers can understand the model without reading source code. This feature does not build a generic async chat runtime; it creates the policy, validation, and documentation foundation for later async job work.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)  
**Primary Dependencies**: Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, Supertest, Next.js App Router, existing dashboard settings docs pipeline  
**Storage**: PostgreSQL 16 with `pgvector`; existing conversations, messages, audit events, and document-processing jobs; no new persistence required in this feature  
**Testing**: Vitest unit and integration coverage in `backend/tests`, plus targeted frontend or documentation verification where the settings/docs surface is touched  
**Target Platform**: Web application with authenticated dashboard chat, anonymous/public chat, embedded chat, and backend API services  
**Project Type**: Web application with `backend/`, `frontend/`, and repo-level docs  
**Performance Goals**: Preserve the current interactive chat latency and streaming behavior by keeping normal chat on the live request path and avoiding any broker or durable job handoff in the critical path  
**Constraints**: No silent downgrade from live chat to background work; no generic async chat queue in this feature; `chatService.ts` and chat routes remain responsibility-limited; operator-facing documentation must be updated in the same delivery  
**Scale/Scope**: Cross-cutting policy/documentation feature touching current chat flows, bootstrap flow, future deferred workflow classification, tests, and operator-facing docs, but not introducing a new public API or background runtime

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass; backend guardrail tests will be added before any policy wiring.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database remains PostgreSQL with `pgvector`. Pass; this feature reuses existing persistence and adds no new storage contract.
- LLM provider defaults remain unchanged. Pass.
- Secrets and keys remain managed through `.env`; no new secrets are expected. Pass.
- Customer data handling and auditability remain explicit. Pass; the feature keeps live chat on the existing audited request path and documents how future async work must surface completion and failure.
- Module boundaries are explicit. Pass; transport stays in routes, orchestration stays in chat/bootstrap services, domain policy moves to a focused execution-class seam, and persistence remains in repositories/audit storage.
- Existing responsibility-limited files are identified and protected. Pass; `chatRoutes.ts`, `publicChatRoutes.ts`, and `chatService.ts` must not absorb generic async workflow logic.
- No backend HTTP contract changes are planned in this feature. Pass; `backend/src/app/http/openapi/document.ts` remains untouched unless discovery proves otherwise.
- User-visible workflow guidance changes, so documentation updates are required in the same change. Pass.

**Post-design check**: Pass. The design formalizes the execution policy in focused modules and docs rather than scattering it through route handlers, queue code, or sales-only notes.

## Project Structure

### Documentation (this feature)

```text
specs/044-async-chat-jobs/
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
│   ├── app/http/routes/
│   │   ├── chatRoutes.ts
│   │   └── publicChatRoutes.ts
│   ├── modules/chat/services/
│   │   ├── chatService.ts
│   │   ├── chatBootstrapService.ts
│   │   └── chatExecutionPolicy.ts
│   └── modules/audit/services/
│       └── auditService.ts
├── tests/
│   ├── integration/
│   └── unit/
└── prompts/

frontend/
├── components/dashboard/settings/
│   └── settings-docs.ts
└── components/dashboard/settings/retrieval-settings-panel.tsx

docs/
├── README.md
└── assistant-execution-model.md

readme.md
```

**Structure Decision**: Keep existing chat request orchestration untouched as the live interaction path. Introduce a focused execution-policy seam under `backend/src/modules/chat/services/` to define which workflows are interactive versus async. Treat documentation as a first-class output in `readme.md` and `docs/` rather than leaving the decision encoded only in tests or code comments. Reuse the existing settings-docs and dashboard-doc surfaces only if in-product guidance is required by the implementation.

## Module Ownership & Seams

- **Transport Layer**:
  - `backend/src/app/http/routes/chatRoutes.ts`
  - `backend/src/app/http/routes/publicChatRoutes.ts`
  - any frontend settings/help entry points that surface operator guidance
- **Orchestration Layer**:
  - `backend/src/modules/chat/services/chatService.ts`
  - `backend/src/modules/chat/services/chatBootstrapService.ts`
- **Domain Layer**:
  - new execution-class policy module that classifies covered workflows
  - focused helpers for interactive overload/cancellation semantics if needed
- **Persistence/Integration Layer**:
  - existing conversation/message repositories
  - existing audit service and audit-event persistence
  - existing document-processing job system as the reference durable async implementation for future follow-on work, not as a dependency to reuse in this feature
- **Files Kept Small**:
  - `backend/src/modules/chat/services/chatService.ts`
  - `backend/src/app/http/routes/chatRoutes.ts`
  - `backend/src/app/http/routes/publicChatRoutes.ts`
- **Planned Extractions**:
  - execution-class policy definitions and workflow classifier
  - test helpers that assert live-chat workflows never require async handoff
  - documentation source file(s) for operator and enterprise explanation
- **Required Refactor Stories**:
  - none expected before implementation; if discovery shows the policy cannot be expressed cleanly without bloating `chatService.ts`, extract the policy seam first

## Phase 0: Research

- Completed in [research.md](/Users/dm/conductor/workspaces/radioso/provo/specs/044-async-chat-jobs/research.md).

## Phase 1: Design & Contracts

- The execution classes, covered workflows, and future async workflow contract are defined in [data-model.md](/Users/dm/conductor/workspaces/radioso/provo/specs/044-async-chat-jobs/data-model.md).
- Validation steps for live-chat preservation, workflow classification, and documentation readiness are defined in [quickstart.md](/Users/dm/conductor/workspaces/radioso/provo/specs/044-async-chat-jobs/quickstart.md).
- No backend HTTP contract change is planned in this feature, so no `contracts/` artifact is required.
- No new runtime prompt assets are planned; if implementation later extracts prompt-driven explanatory copy, those assets must live under `backend/prompts/`.
- Agent context update will be run via `.specify/scripts/bash/update-agent-context.sh codex`.

## Phase 2: Implementation Strategy

1. Add failing backend tests that lock normal authenticated chat, public chat, embedded/bootstrap paths, and future deferred workflow classification to the approved execution classes.
2. Introduce a focused execution-policy seam that defines the current interactive workflows and preserves room for a future durable async class without expanding the responsibilities of `chatService.ts` or route handlers.
3. Wire the existing chat and bootstrap services to rely on the policy seam where needed for guardrail assertions and future extensibility, while preserving current live request behavior.
4. Update operator-facing documentation in `readme.md` and `docs/` so the distinction between live chat and any future background work is explicit, plain-language, and enterprise-review ready.
5. Run targeted validation proving there is no queue-backed handoff in normal chat and that documentation alone is enough to classify covered workflows correctly.

## Post-Design Constitution Check

- TDD remains enforceable because the feature introduces focused guardrail tests before code changes. Pass.
- Stack, database, and provider defaults remain unchanged. Pass.
- No new HTTP contract or prompt-asset drift is planned. Pass.
- Module ownership is clearer after design: live chat stays orchestration-only, execution policy becomes explicit, and documentation ships with the behavior. Pass.

## Complexity Tracking

No constitution violations or justified exceptions are required for this feature.
