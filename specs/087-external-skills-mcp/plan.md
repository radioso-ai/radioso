# Implementation Plan: External Skills via MCP

**Branch**: `087-external-skills-mcp` | **Date**: 2026-06-14 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/087-external-skills-mcp/spec.md`

## Summary

Add a generic, data-driven capability to use external MCP-server tools as Radioso skills, invoked through the **existing `SkillExecutorPort`** (the same seam retrieval uses) so the conversation engine, routine runner, and chat route stay MCP-agnostic. Authors create reusable **MCP connections** and **skill definitions** (a named binding of one discovered tool with bound + exposed params) and reference them in routines by name. New integrations (Slack, Cal.com, …) are **data**, never provider-specific code.

Technical approach: build a new SDK-backed `ToolService` over the official `@modelcontextprotocol/sdk` v1 client (Streamable HTTP + OAuth), reuse the transport-agnostic `ToolSkillBridge` in `packages/conversation-tools` unchanged, add a name→binding resolver + generic MCP skill executor registered via composition, and persist connections/skill-definitions (secrets encrypted). Delivered in priority slices: P1 auth-agnostic spine (token auth, coarse outcome), P2 OAuth, P3 meaning-based outcome branching.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend); TypeScript 5.7 / React 19 / Next.js 16 (frontend)  
**Primary Dependencies**: `@modelcontextprotocol/sdk` v1 (client; NEW), existing `packages/conversation-tools`, `packages/conversation-contract`, `packages/conversation-engine`, Zod, Pino, existing OpenAI/provider adapter  
**Storage**: PostgreSQL (relational tables only: mcp_connections, agent skill definitions; encrypted credential columns via existing `fieldEncryption.ts`)  
**Testing**: Vitest (unit/integration/contract) with a generic in-process mock MCP server fixture; Supertest for routes; Playwright for skill-builder + routine-picker UI  
**Target Platform**: Linux server (backend + worker), browser (dashboard)  
**Project Type**: Web (backend + frontend monorepo)  
**Performance Goals**: External tool invocation bounded by timeout (≤10s default) and failing safely into the routine failure outcome  
**Constraints**: Remote Streamable-HTTP MCP servers only (stdio out of scope); secrets encrypted at rest; no payload/PII/token in logs; engine packages stay MCP-free  
**Scale/Scope**: P1 spine + P2 OAuth + P3 outcome interpretation + admin UI; per-agent scope

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- ✅ Spec exists and is approved (requestor approved; implementation gated to after plan review).
- ✅ Backend TDD: every backend slice writes failing tests first (mock MCP server fixture, ToolService, resolver, executor, repositories, routes). Enforced in tasks ordering.
- ✅ Frontend Playwright for user-visible behavior (connections screen, skill builder, routine picker); frontend unit tests limited to non-visual logic (schema→form derivation, bind/expose state, param-merge preview, API adapters).
- ✅ Stack: Node.js backend, React frontend.
- ✅ Database: PostgreSQL (this feature adds relational tables only; `pgvector` unaffected).
- ⚠️ LLM provider: constitution names GPT-5.2 as default. This feature uses **the configured default provider** for the US3 outcome classifier only; it introduces no new provider and no model hardcoding. Compliant in spirit (uses default provider abstraction). The P1/P2 spine uses NO LLM.
- ✅ Secrets via encrypted store + `.env.example` updated for any new operator config (encryption key reuse). Tokens never in `skillSettings`/plaintext.
- ✅ Customer data: least-privilege — only authored named skills invocable; calls carry only bound + conversation-supplied params; audit/observability without sensitive payloads.
- ✅ Module boundaries explicit (see Module Ownership & Seams). Engine/contract packages stay MCP-free; chat route stays orchestration-only.
- ✅ Responsibility-limited files identified (below); new behavior goes into NEW focused modules, not existing god files.
- ✅ App-wide infrastructure (new skill executor, ToolService, repositories, resolver) wired in `backend/src/app/composition/`; domain rules stay in `backend/src/modules/`.
- ✅ Backend HTTP contract changes go through code-first OpenAPI registry `backend/src/app/http/openapi/document.ts`; `backend/openapi.yaml`/`.json` regenerated, never hand-edited; contract tests added.
- ✅ Message-queue impact review included (Phase 0 / research). Expected outcome: NO queue changes (synchronous in-turn calls). MCP here is an **outbound client**, distinct from the existing inbound MCP *server* contract (`packages/radioso-mcp-server`); confirm no inbound-contract change.
- ✅ Docs parity: routine/skills docs + new MCP-connections settings doc planned; read `docs/document-writer-prompt.md`.

**Gate result: PASS** (one advisory note on LLM provider naming; no violations requiring Complexity Tracking).

## Project Structure

### Documentation (this feature)

```text
specs/087-external-skills-mcp/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (SDK v1, auth slicing, outcome interpretation, mock fixture)
├── data-model.md        # Phase 1 — MCP Connection, Skill Definition entities + validation
├── quickstart.md        # Phase 1 — how to add an integration as data + run the demo
├── contracts/           # Phase 1 — endpoint design notes (mapped to code-first OpenAPI registry)
└── tasks.md             # Phase 2 — task breakdown by story
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── externalSkills/                 # NEW domain module (connections, skill defs, resolver, outcome)
│   │   │   ├── domain.ts                    # Zod schemas + types for connection, skill definition
│   │   │   ├── connections/                 # connection service + repository
│   │   │   ├── skillDefinitions/            # skill-definition service + repository + resolver
│   │   │   ├── toolService/                 # SDK-backed ToolService (Streamable HTTP + auth)
│   │   │   ├── executor/                    # generic MCP skill executor (SkillExecutorPort)
│   │   │   └── outcome/                      # US3 outcome interpretation port + classifier client
│   │   ├── retrieval/services/retrievalAnswerSkillExecutor.ts   # TEMPLATE to mirror (unchanged)
│   │   └── agents/                          # skillSettings reuse for non-secret config (read-only here)
│   ├── app/
│   │   ├── composition/                     # wire executor + ToolService + repos + resolver (defaults)
│   │   └── http/openapi/document.ts         # code-first OpenAPI registry (add routes)
│   ├── shared/infra/crypto/fieldEncryption.ts   # REUSE for credential encryption
│   └── db/migrations/                       # NEW migration: mcp_connections (+ skill defs storage)
├── prompts/                                 # US3 outcome-classifier prompt asset lives here
├── openapi.yaml / openapi.json              # regenerated (never hand-edited)
└── tests/ (unit | integration | contract)   # incl. mock MCP server fixture

packages/
├── conversation-tools/src/skillBridge.ts    # REUSE ToolSkillBridge unchanged
│                       /mcpAdapter.ts        # NOT the runtime client (HTTP-JSON-RPC only)
├── conversation-defaults/src/skillExecutorRegistry.ts  # SkillExecutorPort (register MCP executor)
├── conversation-contract/                    # stays MCP-free
└── conversation-engine/src/routineRunner.ts  # stays MCP-free (branches on RoutineSkillResult.status)

frontend/
├── (settings) connections screen + skill builder
└── (routine authoring) skill picker + outcome branches   # Playwright coverage
```

**Structure Decision**: Web monorepo. A NEW backend module `backend/src/modules/externalSkills/` owns all MCP domain + persistence + the executor; composition wires defaults; the engine/contract packages and chat route are untouched except for registration. Frontend adds a connections screen + skill builder + routine picker.

## Module Ownership & Seams

- **Transport Layer**: new Express routes for connection CRUD, tool discovery, skill-definition CRUD, OAuth authorize/callback — thin handlers mapping requests to services; defined in the code-first OpenAPI registry. No business rules in handlers.
- **Orchestration Layer**: the generic MCP **skill executor** (implements `SkillExecutorPort`) coordinates resolve→merge→callTool→map-outcome but delegates each decision to focused collaborators. Mirrors `RetrievalAnswerSkillExecutor`.
- **Domain Layer**: `externalSkills/skillDefinitions/resolver` (name→binding + param merge), `externalSkills/outcome` (outcome derivation), connection/skill-definition domain rules (`domain.ts`). No transport or persistence concerns.
- **Persistence/Integration Layer**: connection repository + skill-definition repository (Postgres); the SDK-backed `ToolService` (external MCP client) is the integration gateway; credentials encrypted via `fieldEncryption.ts` + the existing secret store.
- **Application Composition**: `backend/src/app/composition/` registers the MCP skill executor with the skill executor registry, builds the `ToolService` factory (per connection), and wires repositories/resolver. Domain rules stay in the module.
- **Files Kept Small**: `packages/conversation-engine/src/routineRunner.ts`, `packages/conversation-contract/*`, and the chat route handlers MUST NOT gain MCP knowledge. `packages/conversation-tools/src/skillBridge.ts` (`ToolSkillBridge`) is reused **unchanged**.
- **Planned Extractions**: SDK-backed `ToolService`; connection repo/service; skill-definition repo/registry + resolver; generic MCP skill executor; outcome interpretation port; skill-builder/routine-picker API + UI.
- **Required Refactor Stories**: none — the skill executor seam already exists and is load-bearing (retrieval proves it). No oversized target file is being extended; all new behavior lands in the new module.

## Open Decision (flagged for EM)

**OAuth timing vs. the live demo.** P1 ships static-token auth so the spine demos against a mock/dev MCP server. But the headline real targets — Slack's official MCP server and Cal.com's `mcp.cal.com` — are **OAuth 2.1 only**. If the demo must hit real Slack/Cal.com, **US2 (OAuth) must move into the first delivered increment**. The spine is auth-method-agnostic, so this does not change P1's architecture — only the delivery order of the auth method. **Decision required before P1 implementation begins.**

## Complexity Tracking

> No constitution violations requiring justification. Section intentionally empty.
