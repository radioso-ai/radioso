# Implementation Plan: Assistant-Retrieval Boundary

**Branch**: `051-assistant-retrieval-boundary` | **Date**: 2026-04-26 | **Spec**: [spec.md](/Users/dm/conductor/workspaces/radioso/spokane/specs/051-assistant-retrieval-boundary/spec.md)
**Input**: Feature specification from `/specs/051-assistant-retrieval-boundary/spec.md`

## Summary

Introduce a first-class assistant domain that owns human-facing chat behavior,
conversation context, assistant-owned prompts, and assistant-facing routing,
while retrieval becomes a narrower grounded capability with explicit
`/retrieval/search` and `/retrieval/answer` endpoints. The delivery adds one
shared platform settings resource, one shared platform history resource, keeps
public chat and embed as transport adapters over the assistant domain, keeps
anonymous/embed access control and session mechanics in the transport layer,
keeps MCP parallel to assistant by default, and rehomes assistant-facing
settings out of the retrieval-owned contract without changing the underlying
PostgreSQL storage shape.

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 (backend), TypeScript 5.7 with React 19 and Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, `pg`, OpenAI SDK, Pino, Vitest, Supertest, Next.js App Router, existing MCP package under `packages/radioso-mcp-server`
**Storage**: PostgreSQL 16 with existing `workspaces`, `retrieval_settings`, `conversations`, `messages`, `audit_events`, and existing public/embed workspace columns; no schema migration is required for the boundary split itself
**Testing**: Vitest and Supertest for backend TDD, targeted Playwright coverage for any visible settings/history/chat flow changes, minimal frontend unit coverage for API adapters and route-state logic only
**Target Platform**: Web application with authenticated chat, public chat, website embed, dashboard settings/history, and MCP capability access
**Project Type**: Web application with separate `backend/`, `frontend/`, and local package directories
**Performance Goals**: Direct assistant turns skip retrieval entirely, retrieval-backed assistant turns do not add an extra LLM classifier beyond the existing intent path, and retrieval-only clients keep current grounded-answer latency characteristics
**Constraints**: No external messaging connector work, no generic multi-tool agent platform work, no assistant persona leakage into retrieval-only endpoints, no implicit settings-section resets on update, runtime prompts remain under `backend/prompts/`, and code-first OpenAPI remains the source of truth for HTTP contracts
**Scale/Scope**: Cross-cutting backend boundary refactor plus targeted frontend API/settings/history updates and MCP adapter remapping; no deploy-topology split and no new persistence systems

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Spec exists and is approved; no implementation without spec. Pass: approved spec exists in `specs/051-assistant-retrieval-boundary/`.
- Backend work includes TDD with failing tests written before implementation. Pass: implementation starts with route, assistant-domain, retrieval-endpoint, and settings-merge red tests.
- Frontend user-visible behavior is planned for Playwright coverage, and any frontend unit tests are limited to non-visual logic. Pass: route and settings UX changes will use Playwright where visible, with frontend unit tests limited to `frontend/lib/api.ts` and route-state helpers if needed.
- Stack remains Node.js for backend and React for frontend. Pass.
- Database is PostgreSQL with `pgvector` for embeddings and vector search. Pass: existing retrieval persistence remains in PostgreSQL.
- LLM provider is GPT-5.2 for AI integrations. Pass: assistant and retrieval continue using the existing provider registry.
- Secrets and keys are managed via `.env` and `.env.example` is updated. Pass: no new secret is required for the boundary split itself.
- Customer data handling and auditability are addressed where applicable. Pass: route diagnostics and source metadata remain auditable, and no new cross-workspace data path is introduced.
- Module boundaries between transport, orchestration, domain logic, and persistence are explicit. Pass with the new assistant module, shared settings aggregator, and retrieval capability routes described below.
- Existing responsibility-limited files are identified, and the plan explains how new behavior avoids turning them into god objects. Pass: `chatRoutes.ts`, `publicChatRoutes.ts`, `settingsRoutes.ts`, `chatService.ts`, and `sharedAnswerInstructionBuilder.ts` are explicitly constrained.
- If the current structure is unclear or target files are already too large, the plan adds architecture/refactor stories that must land before feature work in those areas. Pass: assistant extraction and settings aggregation land before transport rewiring.
- If backend HTTP contracts change, the plan identifies updates required in `backend/src/app/http/openapi/document.ts` and treats `backend/openapi.yaml` / `backend/openapi.json` as generated outputs, never hand-authored sources. Pass: new assistant, retrieval, history, and settings contracts require OpenAPI registry and generated artifact updates.
- If contracts, workflows, settings behavior, or user-visible functionality change, the plan identifies which docs must be updated in the same feature work. Pass: API docs, MCP setup docs, repo README, and settings docs all need updates.

## Project Structure

### Documentation (this feature)

```text
specs/051-assistant-retrieval-boundary/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── assistant-retrieval-api-contract.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/openapi/document.ts
│   ├── app/http/routes/
│   │   ├── index.ts
│   │   ├── chatRoutes.ts
│   │   ├── publicChatRoutes.ts
│   │   ├── publicEmbedRoutes.ts
│   │   ├── settingsRoutes.ts
│   │   └── mcpContextRoutes.ts
│   ├── app/server/
│   │   ├── dependencies.ts
│   │   └── types.ts
│   ├── modules/assistant/
│   │   ├── domain/
│   │   ├── services/
│   │   └── types/
│   ├── modules/chat/services/
│   │   ├── chatService.ts
│   │   ├── chatBootstrapService.ts
│   │   ├── chatHistoryService.ts
│   │   └── nonRetrievalAnswerPromptBuilder.ts
│   ├── modules/retrieval/
│   │   ├── domain/
│   │   └── services/
│   └── modules/settings/
│       ├── domain/
│       └── services/
├── prompts/
│   ├── chat/
│   └── retrieval/
├── tests/
│   ├── integration/
│   ├── contract/
│   └── unit/
└── openapi.yaml

frontend/
├── components/dashboard/
│   ├── chat-history-view.tsx
│   └── settings/
├── docs/settings-docs/
│   ├── general/
│   └── retrieval/
└── lib/api.ts

packages/
└── radioso-mcp-server/
    └── src/
        ├── radiosoApiAdapter.ts
        └── tools/

docs/
├── mcp-client-setup.md
└── settings-docs/
```

**Structure Decision**: This remains a single deployed web application, but the
code boundary changes are significant enough to justify a new
`backend/src/modules/assistant/` ownership layer. Public chat and embed stay as
transport adapters. Retrieval remains a sibling backend capability. MCP stays a
parallel package surface that consumes retrieval and platform contracts directly
by default.

## Module Ownership & Seams

- **Transport Layer**:
  - `backend/src/app/http/routes/chatRoutes.ts` becomes the authenticated
    assistant transport for `POST /api/v1/assistant/chat`.
  - `backend/src/app/http/routes/publicChatRoutes.ts` and
    `backend/src/app/http/routes/publicEmbedRoutes.ts` remain public/embed
    transports only and normalize into the assistant domain.
  - Anonymous/public chat transport continues to own token validation,
    anonymous-session continuity, and rate limiting.
  - Website embed transport continues to own approved-origin checks, embed
    session issuance, and embed-launch access control.
  - `backend/src/app/http/routes/settingsRoutes.ts` becomes the shared platform
    settings transport plus existing ingestion subresource transport.
  - `backend/src/app/http/routes/mcpContextRoutes.ts` remains MCP capability
    discovery only and does not proxy assistant policy.
- **Orchestration Layer**:
  - A new assistant application service owns conversation loading, assistant
    route selection, direct-answer execution, retrieval delegation, persistence,
    and route diagnostics.
  - Retrieval application services own grounded search and grounded answer
    execution without assistant persona or social handling.
- **Domain Layer**:
  - Assistant domain owns assistant chat request normalization, assistant route
    decisions, assistant settings aggregation, assistant-owned prompt building,
    and platform history semantics.
  - The assistant settings seam is the canonical owner of assistant identity,
    greeting behavior, locale defaults, conversation mode, suggested questions,
    and custom instruction assembly, even when some persisted fields still live
    in existing retrieval settings storage during the transition.
  - Retrieval domain owns rewrite, evidence lookup, ranking, grounded answer
    generation, and typed unsupported retrieval outcomes.
  - Settings domain owns shared resource aggregation and merge-safe update
    semantics across assistant, retrieval, and channel sections.
- **Persistence/Integration Layer**:
  - Existing workspace and retrieval settings repositories remain the storage
    owners.
  - Existing conversation and message repositories remain the source of truth
    for assistant history.
  - MCP package adapter becomes a retrieval/platform consumer instead of a chat
    consumer by default.
- **Files Kept Small**:
  - `backend/src/app/http/routes/chatRoutes.ts` must not keep route-selection
    policy.
  - `backend/src/app/http/routes/publicChatRoutes.ts` must not keep assistant
    business rules.
  - `backend/src/app/http/routes/settingsRoutes.ts` must not embed cross-section
    merge logic inline.
  - `backend/src/modules/chat/services/chatService.ts` must not remain the
    final home for both assistant policy and retrieval execution.
  - `backend/src/modules/retrieval/services/sharedAnswerInstructionBuilder.ts`
    must not continue owning assistant identity and non-retrieval answer policy.
- **Planned Extractions**:
  - `backend/src/modules/assistant/services/assistantChatService.ts`
  - `backend/src/modules/assistant/services/assistantRouteService.ts`
  - `backend/src/modules/assistant/services/assistantSettingsService.ts`
  - `backend/src/modules/assistant/services/assistantHistoryService.ts`
  - `backend/src/modules/assistant/services/assistantInstructionBuilder.ts`
  - `backend/src/modules/assistant/domain/assistantSettings.ts`
  - `backend/src/modules/retrieval/services/retrievalAnswerService.ts`
  - `backend/src/modules/retrieval/services/retrievalSearchService.ts`
  - shared platform settings response/update schemas
- **Required Refactor Stories**:
  - Extract assistant-owned prompt and routing concerns before introducing new
    HTTP contracts.
  - Aggregate assistant/retrieval/channel settings behind one service before
    rewriting frontend settings consumers.
  - Repoint MCP to retrieval/platform endpoints before removing its dependence
    on `/api/v1/chat`.

## Phase 0: Research

- Completed in [research.md](/Users/dm/conductor/workspaces/radioso/spokane/specs/051-assistant-retrieval-boundary/research.md).

## Phase 1: Design & Contracts

- Shared entities and ownership boundaries are documented in
  [data-model.md](/Users/dm/conductor/workspaces/radioso/spokane/specs/051-assistant-retrieval-boundary/data-model.md).
- Request and response contracts for assistant, retrieval, settings, and
  history are documented in
  [assistant-retrieval-api-contract.md](/Users/dm/conductor/workspaces/radioso/spokane/specs/051-assistant-retrieval-boundary/contracts/assistant-retrieval-api-contract.md).
- Validation scenarios for assistant-direct, assistant-retrieval, retrieval-only,
  settings merge, and MCP capability behavior are documented in
  [quickstart.md](/Users/dm/conductor/workspaces/radioso/spokane/specs/051-assistant-retrieval-boundary/quickstart.md).
- Runtime prompt assets introduced or moved for assistant-owned behavior belong
  under `backend/prompts/`.
- Code-first OpenAPI changes are required in
  `backend/src/app/http/openapi/document.ts`, followed by regeneration of
  `backend/openapi.yaml` and `backend/openapi.json`.

## Phase 2: Implementation Strategy

1. Create `backend/src/modules/assistant/` and move assistant-owned routing,
   prompt assembly, settings composition, and history ownership there.
2. Shrink `chatRoutes.ts`, `publicChatRoutes.ts`, and `publicEmbedRoutes.ts`
   into transport adapters that call the assistant module instead of owning chat
   policy directly.
3. Keep anonymous/public and embed-specific access/session/origin logic in
   their transport adapters while moving all chat execution into the assistant
   module.
4. Add `POST /api/v1/assistant/chat`, `GET /api/v1/history`,
   `GET /api/v1/history/:conversationId`, `POST /api/v1/retrieval/search`, and
   `POST /api/v1/retrieval/answer` with code-first OpenAPI coverage.
5. Replace the mixed `/settings/general` plus `/settings/retrieval` split with a
   shared root `GET/PUT /api/v1/settings` contract that merges assistant,
   retrieval, and channel sections safely while leaving `/settings/ingestion`
   intact.
6. Move assistant-facing settings fields out of the retrieval-owned section:
   `conversationMode`, `suggestedQuestionsEnabled`,
   `suggestedQuestionsCount`, and `customInstruction` become assistant-owned.
7. Keep retrieval-only behavior first-class by adding a typed unsupported result
   contract and by moving MCP grounded-answer usage to `/api/v1/retrieval/answer`
   instead of `/api/v1/chat`.
8. Update frontend API clients, dashboard settings screens, history screens, and
   MCP package adapters to use the new platform contract.
9. Update README, MCP docs, and settings docs in the same feature.

## Documentation Impact

- `readme.md`
- `docs/mcp-client-setup.md`
- `docs/settings-docs/README.md`
- `docs/settings-docs/retrieval/*.md` for fields that move or narrow scope
- `frontend/docs/settings-docs/general/*.md`
- `frontend/docs/settings-docs/retrieval/*.md`

## Test Strategy

- **Backend unit tests**:
  - assistant route selection
  - assistant settings aggregation and merge semantics
  - assistant instruction building
  - retrieval unsupported-result construction
  - MCP adapter remapping decisions
- **Backend integration tests**:
  - `POST /api/v1/assistant/chat` direct-answer path
  - `POST /api/v1/assistant/chat` retrieval-backed path
  - `GET /api/v1/history` and detail
  - `GET/PUT /api/v1/settings` independent section updates
  - `POST /api/v1/retrieval/search`
  - `POST /api/v1/retrieval/answer` supported and unsupported outcomes
  - public chat and embed adapters using the assistant domain
- **Backend contract tests**:
  - OpenAPI request and response shapes for assistant/retrieval/history/settings
  - retrieval unsupported union shape and stable code
- **Frontend Playwright coverage**:
  - authenticated chat still works through assistant route
  - dashboard history still opens assistant conversation history
  - settings save flows preserve untouched sections
- **Frontend unit tests**:
  - `frontend/lib/api.ts` request shaping and response parsing
  - dashboard route-state helpers if history route keys change

## Post-Design Constitution Check

- Backend TDD remains enforceable because assistant routing, retrieval answer
  unions, shared settings aggregation, and transport rewiring each have focused
  seams with isolated tests. Pass.
- Node.js backend, React frontend, PostgreSQL, and GPT-5.2 provider constraints
  remain unchanged. Pass.
- Prompt ownership stays explicit under `backend/prompts/`. Pass.
- OpenAPI changes are explicit and code-first. Pass.
- The plan improves modularity by extracting assistant ownership instead of
  extending the existing mixed `chatService.ts` and retrieval prompt seams.
  Pass.
- Documentation impact is identified for API, settings, and MCP surfaces. Pass.

## Complexity Tracking

No constitution violations or justified exceptions are required for this
feature.
