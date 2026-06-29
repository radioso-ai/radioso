# Implementation Plan: MCP Agent Converse

**Branch**: `098-mcp-agent-converse` | **Date**: 2026-06-27 | **Spec**: `specs/098-mcp-agent-converse/spec.md`
**Input**: Feature specification from `specs/098-mcp-agent-converse/spec.md`

## Summary

Add a Scope 1 MCP converse data plane that lets an external MCP client converse with exactly one Radioso agent using a per-agent access grant, not a workspace API token. The implementation spine is: reuse `agent_access_grants` with `principal_kind = public-launch`, a new `channel = mcp-converse`, and a new `agent` role; exchange a converse launch token through backend-owned HTTP endpoints for a public-chat-session-derived signed session that embeds `grantId` and grant version; re-evaluate the live grant on every MCP request; route `ask_agent` through the existing agent turn loop; then add agent-aware grounded answers/resources and OAuth as additive front doors. The standalone `packages/radioso-mcp-server` remains transport-only and calls backend HTTP contracts rather than importing backend modules or holding signing secrets.

US3 is intentionally deferred: signed end-user identity depends on spec 097 / PR #783 merging to `main`. Active delivery order is US1 -> US2 -> US4.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 for backend and MCP package; TypeScript 5.7 / React 19 / Next.js 16 only if the existing grant-management UI is touched by implementation  
**Primary Dependencies**: Express, Zod, Pino, OpenAI/provider adapters, existing public-chat session issuer, access-grant services, assistant/chat turn services, retrieval services, MCP SDK/runtime in `packages/radioso-mcp-server`, Vitest/Supertest/Playwright  
**Storage**: PostgreSQL 16 with `pgvector`; reuse `agent_access_grants`, existing conversation/history tables, and existing document/retrieval persistence. New schema work is limited to widening `agent_access_grants.role`, adding `agent_access_grants.channel`, and adding `mcp` to conversation/source-channel vocabulary.  
**Testing**: Backend TDD with failing Vitest/Supertest unit, integration, and contract tests before implementation; MCP package Vitest tests; Playwright only for any visible dashboard grant-management behavior.  
**Target Platform**: Linux server/self-host runtime; standalone MCP process over stdio/HTTP plus optional merged backend `/mcp` mount.  
**Project Type**: Web/API monorepo with backend, frontend, packages, docs, and TypeScript SDK generated-contract surfaces.  
**Performance Goals**: Per-request grant validation adds one grant lookup/evaluate per MCP request; optional cache, if implemented, must be single-digit seconds and documented as bounded revocation staleness. Long agent turns must not fail solely because session TTL crosses mid-turn. OAuth metadata and exchange endpoints should stay low-latency enough for public MCP connector discovery.  
**Constraints**: Planning only in this step. Scope 1 converse only; no Scope 2 admin/control tools. Workspace API tokens rejected on converse path. Embed/public-link launch tokens rejected because MCP carries no Origin. Standalone MCP transport has no backend imports and no signing secret. User-facing assistant copy remains LLM-generated through the turn loop. Observability/audit must not log prompts, completions, retrieved content, chunks, credentials, cookies, or connection strings.  
**Scale/Scope**: Agent/app-level converse credentials, not anonymous web-scale. One credential binds to one agent; US2 resources expose only sanitized, read-only, agent-scoped evidence. US3 app-on-behalf identity waits for spec 097.

## Constitution Check

*GATE: passed at plan time; re-check after Phase 1 design.*

- Passed: spec exists at `specs/098-mcp-agent-converse/spec.md` and is Approved.
- Passed: backend work is planned TDD-first. Every backend story starts with failing unit/contract/integration tests before implementation tasks.
- Passed: frontend work is minimal and only for existing grant management if needed; any visible UI behavior uses Playwright, while frontend unit tests are limited to API adapter/data mapping logic.
- Passed: stack remains Node.js backend, React frontend, PostgreSQL 16 with `pgvector`, TypeScript MCP package.
- Passed: no new default LLM provider or runtime prompt asset is introduced. Existing `backend/prompts/` remains the canonical runtime prompt directory if the agent turn loop is touched.
- Passed with task follow-up: secrets remain in `.env`; `.env.example` only changes if OAuth/session config introduces new environment variables.
- Passed: customer data least privilege is central to the plan. Converse credentials authorize one agent only and deny document management, workspace settings, other agents, workspace bearer auth, and embed/public-link tokens.
- Passed: audit/observability tasks cover exchange, validation denials, turns, OAuth, resources, and grounding without sensitive payload logging.
- Passed: module boundaries are explicit below. Transport stays MCP-only; backend owns session/auth/turn/retrieval/resource/OAuth HTTP behavior; persistence stays in repositories; domain decisions stay outside HTTP and composition.
- Passed: responsibility-limited files identified. `packages/radioso-mcp-server` stays transport/client-only; `accessGrantService` stays credential-validity-focused; `AccountAccessService` owns role-to-permission membership; chat/retrieval services stay channel-agnostic; `backend/src/app/http/openapi/document.ts` remains code-first contract registry.
- Passed: planned focused modules prevent route handlers, MCP server, or public-chat middleware from absorbing all behavior.
- Application composition: required. New backend converse route group, session validator, OAuth front door, MCP/HTTP adapters, and default services should be wired from `backend/src/app/composition/` or module composition helpers; product rules stay in modules/shared domain.
- Backend HTTP contracts: required. Update `backend/src/app/http/openapi/document.ts` and path/schema registration; regenerate `backend/openapi.yaml` and `backend/openapi.json` during implementation, never hand-edit them.
- Public/MCP/SDK contracts: required. Backend routes, MCP tools/resources, generated MCP OpenAPI types, and SDK snapshots must stay synchronized via `docs/api-contract-workflow.md`.
- Message-queue impact review: required. Expected result is no document worker dispatch, AMQP payload shape, or retry semantics change; implementation must still record this explicitly and update queue docs/tests only if discovery contradicts the plan.
- Documentation parity: required. Update `docs/mcp-client-setup.md`, `packages/radioso-mcp-server/README.md`, SDK/API docs that mention MCP setup, and `readme.md` only if common run/auth flow changes.

## Project Structure

### Documentation (this feature)

```text
specs/098-mcp-agent-converse/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── mcp-converse-http.md
└── tasks.md
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── app/http/routes/                 # converse route group: exchange, validate, ask, answer, resources, OAuth
│   ├── app/http/schemas/                # Zod request/response schemas for converse HTTP contracts
│   ├── app/http/openapi/                # code-first OpenAPI source; generated yaml/json are outputs
│   ├── app/composition/                 # default wiring for converse services, validators, OAuth, route dependencies
│   ├── modules/account/                 # role/permission mapping for public_chat.* agent role
│   ├── modules/settings/contracts/      # publicChatSession issuer extension for converse session payload
│   ├── modules/settings/services/       # accessGrantService resolveConverseGrant/channel support
│   ├── modules/chat/                    # ask_agent adapter over existing agent turn loop
│   ├── modules/retrieval/               # agent-aware grounded answer/read-only resource projection ports
│   └── db/
│       ├── migrations/                  # agent_access_grants role/channel migration; sourceChannel enum migration if needed
│       └── repositories/                # access grant row/domain mapping with channel/version
├── openapi.yaml                         # generated
├── openapi.json                         # generated
└── tests/
    ├── unit/
    ├── integration/
    └── contract/

packages/
└── radioso-mcp-server/
    ├── src/                             # converse MCP transport, tools/resources, backend HTTP adapter, OAuth client handling
    ├── tests/
    └── testing/

typescript-sdk/
└── src/generated/                       # generated after backend OpenAPI change

docs/
└── mcp-client-setup.md                  # converse setup, launch-token exchange, OAuth, resources
```

**Structure Decision**: Existing web/API monorepo. The new product behavior is backend-owned and exposed through HTTP contracts. The MCP package is a transport and generated-contract client only. No new service or credential store is introduced.

## Module Ownership & Seams

- **Transport Layer**: `packages/radioso-mcp-server/src/` defines MCP tools/resources, receives launch/session/OAuth credentials, calls backend converse HTTP endpoints through `radiosoApiAdapter.ts`, and enforces transport policy that the public converse mount never exposes legacy document-management tools. It does not import backend modules, sign sessions, run retrieval, or run agent turns.
- **Backend HTTP Layer**: new route/schemas/presenters under `backend/src/app/http/` own request validation, auth headers, status codes, error shapes, rate limiting, and OpenAPI registration. They call converse services and permission middleware rather than embedding domain decisions.
- **Authorization Domain**: access grants remain the credential record. `AccessGrantService` gains channel-aware default/resolve methods, including `resolveConverseGrant(token)` enforcing `channel = mcp-converse`; it still evaluates validity and constraints, not MCP permissions. `AccountAccessService` owns `agent` role permission membership through `AGENT_CONVERSE_PERMISSIONS`.
- **Session Domain**: `publicChatSession` issuer is extended with an agent-converse variant carrying `grantId`, grant version, `agentId`, `publicSessionId`, sourceChannel `mcp`, optional OAuth client, and later optional signed end-user identity. Validation rechecks the live grant every request.
- **Orchestration Layer**: a focused converse service coordinates exchange, validate, `ask_agent`, grounded answer, document resource list/read, and OAuth front-door issuance. It delegates turn behavior to existing chat/assistant services and retrieval behavior to existing retrieval services.
- **Persistence/Integration Layer**: Kysely repositories map `agent_access_grants.channel` and role values; migrations are the schema source. No new credential store. Conversation/history persistence is reused for session continuity.
- **Application Composition**: required for default service construction, route dependencies, OAuth authorization server dependencies, MCP merged-mount behavior if present, and any optional cache. Composition assembles implementations only; grant/channel/permission/product rules stay in modules.
- **Files Kept Small**: `packages/radioso-mcp-server/src/server.ts` remains transport assembly; `publicChatRoutes.ts` remains public chat/website embed, not the converse route home; `accessGrantService` does not grow MCP policy checks; `retrievalAnswerService` does not learn HTTP/MCP transport; `chatService`/turn loop does not branch on MCP except receiving provenance metadata.
- **Planned Extractions**: `ConverseGrantResolver`, `ConverseSessionValidator`, `AgentConverseService`, `AgentConverseRetrievalReadService`, `McpConverseOAuthService`, and MCP package `converseApiAdapter`/policy modules as narrow seams.
- **Required Refactor Stories**: none before US1, but implementation must extract converse-specific session validation instead of expanding anonymous/public-chat middleware. If discovery shows public-chat session middleware is too coupled, create a behavior-preserving extraction task before adding converse validation.

## Implementation Phases

- **Foundation**: schema/channel/role support; permission constants; session payload extension; route/service skeletons; OpenAPI contract registration; MCP package generated-contract sync; message-queue impact review.
- **US1 (P1)**: launch-token exchange, per-request validation, `ask_agent`, session continuity, workspace-token rejection, embed/public-link rejection, document-management denial, audit.
- **US2 (P2)**: agent-aware grounded-answer tool, read-only sanitized MCP resources, citation policy parity, document-scope enforcement.
- **US4 (P3)**: OAuth 2.1 front door over the same grant/session issuer: protected-resource metadata, dynamic client registration, PKCE authorization code, refresh.
- **US3 (P2, blocked/deferred)**: app-on-behalf signed end-user identity after spec 097 / PR #783 merges; no active implementation tasks until then.

## Observability

Add audit events and low-cardinality logs/counters for converse session exchange success/failure, grant validation denial reason class, token-channel mismatch, workspace-token rejection, ask-agent turn start/finish/failure, grounded answer/resource access, OAuth authorize/token/refresh outcomes, and resource sanitization denial. Do not log raw messages, completions, retrieved chunks, document content, credentials, session tokens, launch tokens, cookies, or connection strings. Use workspace/agent/grant/session identifiers only where already safe for audit correlation.

## OpenAPI, SDK, MCP, and Queue Impact

- Runtime HTTP contract source: `backend/src/app/http/openapi/document.ts` plus route schema modules. `backend/openapi.yaml` and `backend/openapi.json` are generated outputs.
- Generated downstream artifacts: `typescript-sdk/openapi/*`, `typescript-sdk/src/generated/types.ts`, and `packages/radioso-mcp-server/src/generated/openapiTypes.ts` sync from backend OpenAPI.
- MCP contract source: design notes in `contracts/mcp-converse-http.md`, implementation schemas in backend route Zod/OpenAPI, MCP tool/resource definitions in `packages/radioso-mcp-server/src/`.
- Message queue review: expected no changes to document worker dispatch, AMQP payloads, retry semantics, or queue docs because converse uses existing synchronous chat/retrieval/document-read paths and existing document processing. Tasks require explicit confirmation.

## Complexity Tracking

No constitution violations. The new backend converse service and MCP adapter seams add files, but they prevent worse coupling: putting signing secrets or agent turn/retrieval logic in `packages/radioso-mcp-server`, or stuffing converse validation into public-chat middleware, would violate the approved architecture and make revocation/security behavior harder to reason about.
