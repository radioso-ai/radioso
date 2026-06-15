---
description: "Task list for External Skills via MCP"
---

# Tasks: External Skills via MCP

**Input**: Design documents in `/specs/087-external-skills-mcp/` (plan.md, spec.md, research.md, data-model.md, contracts/)
**Tests**: Backend TDD is REQUIRED (constitution NON-NEGOTIABLE) — tests written and failing before implementation. Frontend user-visible behavior → Playwright; frontend unit tests only for non-visual logic.
**Organization**: Grouped by user story for independent delivery. P1 = auth-agnostic spine; P2 = OAuth; P3 = meaning-based outcomes.

⚠️ **EM decision gates P1 start**: confirm OAuth timing (plan "Open Decision"). If the demo must hit real Slack/Cal.com, deliver Phase 4 (US2/OAuth) together with Phase 3.

> **Progress (2026-06-14):** Foundation partially delivered + Codex-reviewed — **24 tests green**.
> Hardened per review: connect-timeout bound, sanitized failure messages, concurrency-safe connect,
> `context.signal` threading, server-URL userinfo rejection, OAuth `authProvider` seam.

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Add `@modelcontextprotocol/sdk` (v1) to `backend/package.json` (client usage via `@modelcontextprotocol/sdk/client/...`); install at workspace root with pnpm; verify it builds.
- [ ] T002 Scaffold the new module dirs under `backend/src/modules/externalSkills/` (`connections/`, `skillDefinitions/`, `toolService/`, `executor/`, `outcome/`, `domain.ts`) with index barrels; add a local `README.md` brief describing the module boundary (engine stays MCP-free).
- [x] T003 [P] Create a generic in-process **mock MCP server fixture** in `backend/tests/support/mockMcpServer.ts` (configurable tools, input schemas, and `completed`/`error`/distinct-payload responses; Streamable-HTTP compatible). No provider-specific content.

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ No user-story work begins until this phase is complete.**

- [x] T004 [US1] Write failing tests for connection + skill-definition Zod schemas/validation in `backend/tests/unit/externalSkills/domain.test.ts` (URL/SSRF validation, bound/exposed disjoint + required-coverage, skillName uniqueness rules).
- [x] T005 [US1] Implement `backend/src/modules/externalSkills/domain.ts` (Zod schemas + types for MCP Connection and Skill Definition per data-model.md) to pass T004.
- [x] T006 [US1] DB migration in `backend/src/db/migrations/NNN_external_skills.sql`: `mcp_connections` (encrypted credential columns + `encryption_key_id` + status) and skill-definition storage (per-agent), with FKs and uniqueness constraints. Add a forward-only migration test.
- [x] T007 [P] [US1] Write failing tests for the SDK-backed `ToolService` against the mock server (`listTools`, `callTool`, `isError`→failed, success→completed, timeout/transport error→failed) in `backend/tests/integration/externalSkills/toolService.test.ts`.
- [x] T008 [US1] Implement `backend/src/modules/externalSkills/toolService/sdkMcpToolService.ts` over `@modelcontextprotocol/sdk` client (Streamable HTTP; pluggable credential provider; bounded timeout) implementing the `ToolService` interface used by `ToolSkillBridge`. Pass T007. Do NOT use `packages/conversation-tools/src/mcpAdapter.ts` as the runtime client.
- [x] T009a [US1] **(from code review)** Made `@radioso/conversation-tools` a real backend build dependency: the standalone build break was a missing workspace link (`pnpm install` linked `@radioso/conversation-contract`); the `skillBridge.ts:136` error was a cascade, NOT a bug — bridge stays **unchanged**. Added `build:conversation-tools` to backend `build`/`predev:*`/`test*` chains.
- [x] T009 [US1] Confirmed (test `bridgeReuse.test.ts`) that `ToolSkillBridge` is reused **unchanged** with the new `ToolService` via `createToolSkillExecutor` at runtime → settled completed/failed outcomes. 2 tests.

**Checkpoint**: schemas, persistence, and the MCP client transport are ready.

## Phase 3: User Story 1 — Define and use an external skill in a routine (P1) 🎯 MVP

**Goal**: connection + named skill (bound/exposed params) referenced in a routine; routine calls the tool and branches on success/failure. Auth-agnostic spine (token auth).

**Independent Test**: against the mock fixture, define one connection + one skill (one bound, one exposed param), reference in a routine, verify merged-param call + success/failure branching, with no provider code.

### Tests for US1 (write first, ensure FAIL)

- [x] T010 [P] [US1] Repository tests: connection repo + skill-definition repo CRUD + encrypted credential round-trip in `backend/tests/integration/externalSkills/repositories.test.ts`.
- [x] T011 [P] [US1] Resolver tests: name→binding resolution + param merge (bound + exposed), invalid/missing tool, required-param coverage, in `backend/tests/unit/externalSkills/resolver.test.ts`.
- [x] T012 [P] [US1] Executor tests: MCP skill executor implements `SkillExecutorPort`, returns settled `SkillOutcome` mapped to `RoutineSkillResult` (`completed`/`failed`), safe-degrade on timeout/error, in `backend/tests/unit/externalSkills/executor.test.ts`.
- [x] T013 [P] [US1] Route + supertest tests (auth, CRUD, discovery-validated create) + OpenAPI registered; contract artifacts synced. Contract tests for connection + discovery + skill-definition routes (from contracts/endpoints.md) in `backend/tests/contract/externalSkills.contract.test.ts`.
- [ ] T014 [US1] (live e2e — needs an HTTP-reachable MCP server; mock fixture uses in-memory transport) Routine integration test: a routine step referencing a defined skill drives find/call + success branch and failure branch; assert engine/routine-runner remain MCP-free, in `backend/tests/integration/externalSkills/routineInvocation.test.ts`.

### Implementation for US1

- [x] T015 [P] [US1] Connection repository + service in `backend/src/modules/externalSkills/connections/` (encrypt via `backend/src/shared/infra/crypto/fieldEncryption.ts`; status lifecycle).
- [x] T016 [P] [US1] Skill-definition repository + service in `backend/src/modules/externalSkills/skillDefinitions/`.
- [x] T017 [US1] Name→binding **resolver** in `backend/src/modules/externalSkills/skillDefinitions/resolver.ts` (param merge; discovery validation) — depends on T015/T016.
- [x] T018 [US1] Generic MCP **skill executor** in `backend/src/modules/externalSkills/executor/mcpSkillExecutor.ts` implementing `SkillExecutorPort` (mirror `backend/src/modules/retrieval/services/retrievalAnswerSkillExecutor.ts`); resolve→build `ToolService` for the connection→`createToolSkillExecutor` bridge→map outcome.
- [x] T019 [US1] Live wiring done in `dependencyBuilders.ts`: external-skills executor registered where database + `CONNECTOR_ENCRYPTION_KEY` are available (mirrors retrieval; guarded/skipped without the key) and `ExternalSkillRoutineDispatcher` passed to `DefaultRoutineRunner`. Executor ports built from repos via `externalSkills/composition.ts` (decrypt connection lookup + ToolService-with-bearer factory). Typecheck-clean; composition assembly tests green. (`builtIn/externalSkillsModule.ts` also available for module-list use.)
- [x] T020 [US1] Confirm `SkillOutcome.status` → `RoutineSkillResult.status` projection carries verbatim status (the seam the routine runner branches on); add a focused test if a projection point needs adjustment. Engine/contract packages remain unmodified.
- [x] T021 [US1] Routes for connection CRUD + `discover` + skill-definition CRUD in `backend/src/modules/externalSkills/` handlers; define in the code-first OpenAPI registry `backend/src/app/http/openapi/document.ts` (Zod schemas; secrets write-only/masked); authz mirrors agent-management gating. Regenerate `backend/openapi.yaml`/`.json` via the generate script.
- [x] T022 [US1] Observability: span/metric per external tool invocation (connection/server id, tool name, outcome status, latency) — NO payloads/PII/tokens — in the executor; reuse existing tracing/metrics infra.
- [ ] T023 [P] [US1] Frontend: MCP Connections screen (list/create/edit/delete, token field, status) using shared dark theme; Playwright coverage for CRUD.
- [ ] T024 [P] [US1] Frontend: Skill builder (select connection → discover tools → schema-driven bind/expose form → name → save); Playwright for the build flow; unit tests only for schema→form derivation + param-merge preview + API adapter.
- [ ] T025 [US1] Frontend: routine-authoring picker lists defined skills by name and exposes success/failure branches; Playwright for referencing a skill in a routine.
- [x] T026 [US1] Docs: update routine/skills docs + add operator-facing MCP-connections settings doc (read `docs/document-writer-prompt.md` first). Update `.env.example` if new operator config is required.

**Checkpoint**: US1 fully functional and demoable against the mock server, end-to-end, no provider code.

## Phase 4: User Story 2 — OAuth-authenticated connections (P2)

**Goal**: connections that authorize once via OAuth; calls use stored, auto-refreshed credentials. (Promote into Phase 3 delivery if real Slack/Cal.com demo is required — EM decision.)

### Tests for US2 (write first, ensure FAIL)

- [ ] T027 [P] [US2] OAuth flow tests against a mock authorization server (authorize URL, callback, token storage, refresh-before-call, refresh-failure→`needs_reauth`) in `backend/tests/integration/externalSkills/oauth.test.ts`.

### Implementation for US2

- [ ] T028 [US2] OAuth credential provider in `backend/src/modules/externalSkills/connections/oauth/` using the SDK OAuth client helpers; encrypted token storage + refresh; status transitions.
- [ ] T029 [US2] OAuth authorize/callback routes in the code-first OpenAPI registry; regenerate OpenAPI; contract tests.
- [ ] T030 [US2] Frontend: connection auth-method = OAuth, "Authorize" action + status indicator; Playwright.
- [ ] T031 [US2] Docs: document OAuth connection setup (incl. provider app registration note, e.g. Slack app id) in the MCP-connections settings doc.

**Checkpoint**: real OAuth-only MCP servers (Slack, Cal.com) usable.

## Phase 5: User Story 3 — Meaning-based outcome branching (P3)

**Goal**: routines branch on named outcomes derived from the tool result (language-neutral).

### Tests for US3 (write first, ensure FAIL)

- [ ] T032 [P] [US3] Outcome-interpreter tests: distinct mock result payloads → distinct named statuses; declarative `outcomeMap` path; default classifier path; a non-English conversation case, in `backend/tests/unit/externalSkills/outcome.test.ts`.

### Implementation for US3

- [ ] T033 [US3] Outcome interpretation port in `backend/src/modules/externalSkills/outcome/` — declarative `outcomeMap` first; default model-assisted classifier using the configured default provider. NO English keyword lists.
- [ ] T034 [US3] Add the outcome-classifier prompt asset under `backend/prompts/` (constitution X); wire loader/tests.
- [ ] T035 [US3] Extend the executor to derive named outcomes and expose them as `RoutineSkillResult.status`; skill-definition `declaredOutcomes` feed the routine picker's branch options.
- [ ] T036 [US3] Frontend: skill builder lets authors declare named outcomes; routine picker surfaces them as branches; Playwright.
- [ ] T037 [US3] Docs: document meaning-based outcomes + how to declare/branch.

## Phase N: Polish & Cross-Cutting

- [ ] T038 Re-run message-queue impact review; confirm no AMQP/worker changes (or add tasks if found).
- [ ] T039 Regenerate + verify `backend/openapi.yaml`/`.json`; ensure contract tests align; never hand-edit generated files.
- [ ] T040 [P] Boundary test/lint: assert no MCP import in `packages/conversation-engine`, `packages/conversation-contract`, or chat route handlers (SC-006).
- [ ] T041 [P] Run `quickstart.md` validation end-to-end against the mock server.
- [ ] T042 Final docs pass (routine/skills + MCP-connections settings doc) and `.env.example` review.

## Dependencies & Execution Order

- **Setup (P1 tasks T001–T003)** → **Foundational (T004–T009)** → blocks all stories.
- **US1 (T010–T026)**: the MVP spine; tests (T010–T014) before implementation (T015+). Resolver (T017) depends on repos (T015–T016); executor (T018) depends on resolver + ToolService; composition (T019) after executor; routes (T021) after services; UI (T023–T025) after routes.
- **US2 (T027–T031)**: after Foundational; integrates with US1 connection model. **May be pulled forward with US1** per the EM OAuth decision.
- **US3 (T032–T037)**: after US1; additive outcome layer.
- **Polish (T038–T042)**: after delivered stories.

## Parallel Opportunities

- T003 (mock fixture) parallel with T004/T005.
- Within US1: T010/T011/T012/T013 (tests) parallel; T015/T016 (repos) parallel; T023/T024 (UI screens) parallel.

## Notes

- Verify backend tests FAIL before implementing (constitution II).
- No provider-specific (Slack/Cal.com) code anywhere — integrations are data (SC-003).
- Secrets only in the encrypted store; never in `skillSettings`, logs, or traces.
- Commit after each task or logical group.
