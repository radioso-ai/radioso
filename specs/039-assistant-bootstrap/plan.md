# Implementation Plan: Assistant Bootstrap

**Branch**: `039-assistant-bootstrap` | **Date**: 2026-04-15 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/port-louis/specs/039-assistant-bootstrap/spec.md)
**Input**: Feature specification from `/specs/039-assistant-bootstrap/spec.md`

## Summary

Add workspace-scoped assistant bootstrap settings to General Settings, extend authenticated and public chat startup to accept request-scoped `userExpectedLocale`, and generate an optional first assistant greeting for brand-new conversations without polluting retrieval settings or route handlers. The implementation uses additive workspace persistence, a focused bootstrap orchestration seam for first-turn creation, frontend bootstrap requests in both chat surfaces, and code-first OpenAPI updates for the changed settings/chat contracts.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 24 (backend), TypeScript 5.7 + React 19 + Next.js 16 (frontend)
**Primary Dependencies**: Express, `pg`, Zod, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router  
**Storage**: PostgreSQL 16 with additive workspace-scoped columns on `workspaces`; existing conversations/messages tables  
**Testing**: Vitest unit/contract/integration tests for backend; targeted frontend verification through existing component behavior  
**Target Platform**: Web application with authenticated dashboard chat and public chat share links  
**Project Type**: Web application (`backend/` + `frontend/`)  
**Performance Goals**: New-chat bootstrap should add only one bounded startup request and must not materially degrade first interaction latency for standard chat startup  
**Constraints**: Preserve route/module boundaries, keep bootstrap failures non-blocking, validate locale hints narrowly, regenerate code-first OpenAPI outputs for HTTP changes  
**Scale/Scope**: Cross-cutting backend/frontend feature touching workspace settings, chat startup transport, public chat startup, conversation persistence, OpenAPI, and chat UI bootstrap flows

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass.
- Backend work includes TDD with failing tests written before implementation. Pass: backend tasks start with contract/integration/unit tests.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: only additive workspace columns; no storage deviation.
- LLM provider is GPT-5.2 for AI integrations. Pass: bootstrap generation reuses the existing provider stack.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secret is planned.
- Customer data handling and auditability are addressed where applicable. Pass: bootstrap uses existing workspace/session scoping and audit signals for startup outcomes.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass: plan introduces a dedicated bootstrap orchestration seam.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `settingsRoutes.ts`, `chatRoutes.ts`, and `publicChatRoutes.ts` stay transport-only; retrieval settings remain retrieval-only.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: plan includes extraction of a focused bootstrap service rather than route/service sprawl.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: README and settings/operator-facing docs must be updated if surface behavior changes.

## Project Structure

### Documentation (this feature)

```text
specs/039-assistant-bootstrap/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── chat-bootstrap-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/openapi/document.ts
│   ├── app/http/routes/chatRoutes.ts
│   ├── app/http/routes/publicChatRoutes.ts
│   ├── app/http/routes/settingsRoutes.ts
│   ├── db/migrations/
│   ├── db/repositories/conversationRepository.ts
│   ├── db/repositories/workspaceRepository.ts
│   ├── modules/chat/services/
│   └── modules/settings/
├── openapi.yaml
├── openapi.json
├── scripts/generateOpenApi.ts
└── tests/

frontend/
├── app/chat/[token]/page.tsx
├── components/dashboard/chat-view.tsx
├── components/dashboard/settings/general-tab.tsx
└── lib/
    ├── api.ts
    ├── anonymous-chat-context.tsx
    └── chat-context.tsx
```

**Structure Decision**: Keep transport changes in `settingsRoutes.ts`, `chatRoutes.ts`, `publicChatRoutes.ts`, and the code-first registry in `backend/src/app/http/openapi/document.ts`. Keep workspace bootstrap normalization and persistence ownership inside settings-domain modules and `workspaceRepository.ts`. Add a focused chat bootstrap/startup service under `backend/src/modules/chat/services/` to decide whether to create a greeting and which locale to use. Frontend General Settings remains the operator-facing configuration surface, while authenticated and public chat contexts own the bootstrap request lifecycle for new conversations.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/publicChatRoutes.ts`, and frontend API/context request wrappers translate requests and responses only.
- **Orchestration Layer**: `backend/src/modules/settings/services/*` owns assistant bootstrap load/save behavior; a new `chat bootstrap` service owns first-turn startup orchestration and delegates persistence/model calls.
- **Domain Layer**: Focused assistant-bootstrap settings normalization and locale resolution rules live in dedicated settings/chat service modules, not in route files.
- **Persistence/Integration Layer**: `backend/src/db/repositories/workspaceRepository.ts` persists workspace bootstrap settings; `conversationRepository.ts` and `messageRepository.ts` persist bootstrap-created conversations/messages; OpenAI provider integration remains behind the existing chat gateway.
- **Files Kept Small**: `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/publicChatRoutes.ts`, `backend/src/modules/settings/domain/retrievalSettings.ts`, `frontend/components/dashboard/chat-view.tsx`.
- **Planned Extractions**: New assistant-bootstrap settings domain/service seam; new chat-start/bootstrap orchestration service; shared locale-resolution helper.
- **Required Refactor Stories**: None beyond the planned bootstrap extraction; the new seam is sufficient to avoid bloating existing route and answer-generation code.

## Complexity Tracking

No constitution violations requiring justification.
