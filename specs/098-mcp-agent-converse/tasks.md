# Tasks: MCP Agent Converse (098)

**Input**: `specs/098-mcp-agent-converse/{spec,plan,research,data-model,quickstart}.md` and `specs/098-mcp-agent-converse/contracts/`  
**Prerequisites**: plan.md, spec.md (Approved), research.md, data-model.md, contracts/, quickstart.md  
**TDD**: Backend tests are required and must be written/failing before implementation tasks.  
**Delivery Order**: Active delivery is US1 (P1) -> US2 (P2) -> US4 (P3). US3 (P2) is deferred/blocked until spec 097 / PR #783 merges to `main`.

---

## Phase 1: Setup (Shared Planning and Contract Grounding)

**Purpose**: Establish exact implementation references before code work starts.

- [ ] T001 Read `docs/agent-context-workflow.md` and `docs/architecture/code-map.md` before opening broad source directories
- [ ] T002 [P] Read backend HTTP ownership brief in `backend/src/app/http/README.md`
- [ ] T003 [P] Read composition ownership brief in `backend/src/app/composition/README.md`
- [ ] T004 [P] Read persistence ownership brief in `backend/src/db/repositories/README.md`
- [ ] T005 [P] Read MCP package ownership brief in `packages/radioso-mcp-server/src/README.md`
- [ ] T006 [P] Read documentation authoring rules in `docs/document-writer-prompt.md` before later docs edits

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Schema, permission, session, route, contract, and transport substrate required before any story implementation.

**Critical**: No active user story work starts until this phase is complete.

### Tests First

- [ ] T007 [P] Add failing migration/repository integration tests for `agent_access_grants.channel` and `role = agent` in `backend/tests/integration/access-grants-repository.integration.test.ts`
- [ ] T008 [P] Add failing account permission unit tests for `AGENT_CONVERSE_PERMISSIONS` and denied workspace/document-management permissions in `backend/tests/unit/account-access-service.test.ts`
- [ ] T009 [P] Add failing access-grant service unit tests for `resolveConverseGrant`, `mcp-converse` channel enforcement, and embed/public-link rejection in `backend/tests/unit/access-grant-service.test.ts`
- [ ] T010 [P] Add failing public-chat-session contract tests for converse payload fields `grantId`, grant version, and sourceChannel `mcp` in `backend/tests/contract/public-chat-session.contract.test.ts`
- [ ] T011 [P] Add failing architecture-boundary test preventing `packages/radioso-mcp-server` from importing `backend/src` in `backend/tests/unit/architecture-boundaries.test.ts`

### Implementation Substrate

- [ ] T012 Add migration for `agent_access_grants.channel` and widened role CHECK in `backend/src/db/migrations/1xx_agent_access_grants_mcp_converse.sql`
- [ ] T013 Update access-grant domain types for `AccessGrantRole = "public" | "agent"` and `channel` in `backend/src/modules/settings/contracts/accessGrants/domain.ts`
- [ ] T014 Update access-grant repository row mapping and Kysely schema usage for `channel` in `backend/src/db/repositories/accessGrantRepository.ts`
- [ ] T015 Update `AccessGrantService` defaults and add `resolveConverseGrant` in `backend/src/modules/settings/services/accessGrantService.ts`
- [ ] T016 Add `public_chat.retrieval.query`, `public_chat.documents.read.scoped`, and `AGENT_CONVERSE_PERMISSIONS` in `backend/src/modules/account/services/accountAccessService.ts`
- [ ] T017 Add `agent` branch to `AccountAccessService.principalRoleAllows` in `backend/src/modules/account/services/accountAccessService.ts`
- [ ] T018 Extend public-chat session issuer/verifier with converse session payload and grant version in `backend/src/modules/settings/contracts/publicChatSession.ts`
- [ ] T019 Add `mcp` to source-channel vocabulary and conversation/history mapping in `backend/src/modules/chat/contracts/sourceChannel.ts`
- [ ] T020 Register initial converse route group and OpenAPI path shell in `backend/src/app/http/routes/mcpConverseRoutes.ts` and `backend/src/app/http/openapi/document.ts`
- [ ] T021 Complete message-queue impact review and record the no-change conclusion in `specs/098-mcp-agent-converse/contracts/mcp-converse-http.md`

**Checkpoint**: Foundation ready. User story implementation can begin in active priority order.

---

## Phase 3: User Story 1 - Converse with one agent using a per-agent credential (P1, MVP)

**Goal**: Exchange an MCP converse grant for a signed session and call one `ask_agent` tool that runs the bound agent's full turn loop while denying workspace-token, embed/public-link, document-management, and other-agent access.

**Independent Test**: Mint a converse grant for a test agent, exchange it, call `ask_agent` twice, verify turn-loop parity/history continuity, reject workspace API token, deny document-management tools, reject other-agent targeting, and invalidate the next request after grant revoke/rotate/disable/expiry.

### Tests for User Story 1

- [ ] T022 [P] [US1] Add failing backend contract tests for `POST /api/v1/mcp/converse/session`, `/session/validate`, and `/ask` in `backend/tests/contract/mcp-converse.contract.test.ts`
- [ ] T023 [P] [US1] Add failing backend integration test for launch-token exchange plus two-turn `ask_agent` continuity in `backend/tests/integration/mcp-converse.integration.test.ts`
- [ ] T024 [P] [US1] Add failing backend integration tests for workspace API token rejection and embed/public-link token rejection in `backend/tests/integration/mcp-converse-auth.integration.test.ts`
- [ ] T025 [P] [US1] Add failing backend integration tests for per-request grant revoke/disable/rotate/expiry invalidation in `backend/tests/integration/mcp-converse-session-revalidation.integration.test.ts`
- [ ] T026 [P] [US1] Add failing MCP package tests for public converse tool list exposing `ask_agent` and denying document-management tools in `packages/radioso-mcp-server/tests/converseTools.test.ts`
- [ ] T027 [P] [US1] Add failing MCP package tests for backend HTTP adapter exchange/validate/ask calls in `packages/radioso-mcp-server/tests/converseApiAdapter.test.ts`

### Implementation for User Story 1

- [ ] T028 [US1] Implement `AgentConverseSessionService` for exchange and per-request validation in `backend/src/modules/settings/services/agentConverseSessionService.ts`
- [ ] T029 [US1] Implement `AgentConverseService.askAgent` as a thin adapter over the existing chat turn loop in `backend/src/modules/chat/services/agentConverseService.ts`
- [ ] T030 [US1] Implement converse session middleware that rejects workspace bearer tokens in `backend/src/app/http/middleware/requireMcpConverseSession.ts`
- [ ] T031 [US1] Implement exchange, validate, and ask route handlers in `backend/src/app/http/routes/mcpConverseRoutes.ts`
- [ ] T032 [US1] Register US1 request/response/error schemas in `backend/src/app/http/schemas/mcpConverseSchemas.ts`
- [ ] T033 [US1] Register US1 OpenAPI paths in `backend/src/app/http/openapi/document.ts`
- [ ] T034 [US1] Wire converse services/routes/default dependencies in `backend/src/app/composition/defaultComposition.ts`
- [ ] T035 [US1] Implement MCP `ask_agent` tool and public-converse policy denial of legacy document-management tools in `packages/radioso-mcp-server/src/tools/converseTools.ts`
- [ ] T036 [US1] Implement MCP backend converse adapter methods in `packages/radioso-mcp-server/src/converseApiAdapter.ts`
- [ ] T037 [US1] Add audit/logging for exchange, validation denial, workspace-token rejection, grant revocation, and ask turn outcomes in `backend/src/modules/chat/services/agentConverseAudit.ts`
- [ ] T038 [US1] Regenerate backend OpenAPI and sync MCP/SDK generated contract artifacts in `backend/openapi.json`, `backend/openapi.yaml`, `packages/radioso-mcp-server/src/generated/openapiTypes.ts`, and `typescript-sdk/src/generated/types.ts`

**Checkpoint**: US1 MVP is independently functional and demoable.

---

## Phase 4: User Story 2 - Agent-aware grounded read surface (P2)

**Goal**: Add an agent-aware grounded-answer tool and read-only sanitized MCP resources scoped to the bound agent, without reintroducing document-management tools.

**Independent Test**: Configure non-default retrieval for one agent, compare MCP grounded answer with in-product chat evidence/citation behavior, list/read only agent-visible resources, and verify outside-scope documents and internal ids are not exposed.

### Tests for User Story 2

- [ ] T039 [P] [US2] Add failing backend integration tests for agent retrieval parity in `backend/tests/integration/mcp-converse-grounded-answer.integration.test.ts`
- [ ] T040 [P] [US2] Add failing backend contract tests for grounded-answer and resources endpoints in `backend/tests/contract/mcp-converse-resources.contract.test.ts`
- [ ] T041 [P] [US2] Add failing backend unit tests for sanitized resource presenter hiding internal document/chunk ids in `backend/tests/unit/mcp-converse-resource-presenter.test.ts`
- [ ] T042 [P] [US2] Add failing MCP package tests for `answer_grounded` using converse backend endpoint and MCP resources list/read in `packages/radioso-mcp-server/tests/converseReadSurface.test.ts`

### Implementation for User Story 2

- [ ] T043 [US2] Implement agent-aware grounded answer service using bound agent retrieval settings in `backend/src/modules/retrieval/services/agentConverseGroundedAnswerService.ts`
- [ ] T044 [US2] Implement read-only agent document resource service in `backend/src/modules/documents/services/agentConverseResourceService.ts`
- [ ] T045 [US2] Implement public-surface resource presenter and sanitization in `backend/src/app/http/presenters/mcpConverseResourcePresenter.ts`
- [ ] T046 [US2] Add grounded-answer and resource route handlers in `backend/src/app/http/routes/mcpConverseRoutes.ts`
- [ ] T047 [US2] Register US2 schemas and OpenAPI paths in `backend/src/app/http/schemas/mcpConverseSchemas.ts` and `backend/src/app/http/openapi/document.ts`
- [ ] T048 [US2] Wire retrieval/resource services in `backend/src/app/composition/defaultComposition.ts`
- [ ] T049 [US2] Implement MCP `answer_grounded` converse call and MCP resources handlers in `packages/radioso-mcp-server/src/tools/converseReadTools.ts`
- [ ] T050 [US2] Regenerate backend OpenAPI and sync MCP/SDK generated contract artifacts in `backend/openapi.json`, `backend/openapi.yaml`, `packages/radioso-mcp-server/src/generated/openapiTypes.ts`, and `typescript-sdk/src/generated/types.ts`

**Checkpoint**: US1 and US2 work independently; document-management tools remain denied.

---

## Phase 5: User Story 4 - OAuth 2.1 front door for public connectors (P3)

**Goal**: Add OAuth 2.1 connector authorization as an alternate front door that issues the same agent-scoped converse session authority as launch-token exchange.

**Independent Test**: Complete protected-resource discovery, dynamic client registration, PKCE authorization-code flow, `ask_agent`, refresh, and grant revocation/rotation failure with an OAuth-capable MCP connector or harness.

### Tests for User Story 4

- [ ] T051 [P] [US4] Add failing backend contract tests for OAuth metadata, dynamic client registration, authorize, and token endpoints in `backend/tests/contract/mcp-oauth.contract.test.ts`
- [ ] T052 [P] [US4] Add failing backend integration tests for PKCE authorization code, refresh, and grant revalidation in `backend/tests/integration/mcp-oauth.integration.test.ts`
- [ ] T053 [P] [US4] Add failing MCP package OAuth connector flow tests in `packages/radioso-mcp-server/tests/converseOAuth.test.ts`

### Implementation for User Story 4

- [ ] T054 [US4] Implement OAuth client registration and metadata service in `backend/src/modules/settings/services/mcpConverseOAuthService.ts`
- [ ] T055 [US4] Implement PKCE authorize/code/token/refresh handling over converse grant/session issuance in `backend/src/modules/settings/services/mcpConverseOAuthService.ts`
- [ ] T056 [US4] Add OAuth route handlers in `backend/src/app/http/routes/mcpConverseOAuthRoutes.ts`
- [ ] T057 [US4] Register OAuth schemas and OpenAPI/protected-resource metadata contracts in `backend/src/app/http/schemas/mcpConverseOAuthSchemas.ts` and `backend/src/app/http/openapi/document.ts`
- [ ] T058 [US4] Wire OAuth service/routes/default dependencies in `backend/src/app/composition/defaultComposition.ts`
- [ ] T059 [US4] Add MCP package OAuth configuration and session refresh handling in `packages/radioso-mcp-server/src/auth/converseOAuth.ts`
- [ ] T060 [US4] Regenerate backend OpenAPI and sync MCP/SDK generated contract artifacts in `backend/openapi.json`, `backend/openapi.yaml`, `packages/radioso-mcp-server/src/generated/openapiTypes.ts`, and `typescript-sdk/src/generated/types.ts`

**Checkpoint**: OAuth connectors can converse with the agent without pasted pre-minted sessions.

---

## Deferred Phase: User Story 3 - End-user identity for app-on-behalf integrations (P2, BLOCKED)

**Status**: Do not start until spec 097 / PR #783 has merged to `main` and the signed end-user identity mechanism is available on this branch.

- [ ] T061 [P] [US3] BLOCKED: After spec 097 merges, read its signed-identity contracts in `specs/097-*/` and update `specs/098-mcp-agent-converse/plan.md` if the integration shape changed
- [ ] T062 [P] [US3] BLOCKED: Add failing tests for two signed end-user identities under one converse credential in `backend/tests/integration/mcp-converse-end-user-identity.integration.test.ts`
- [ ] T063 [US3] BLOCKED: Reuse spec 097 signed-identity verifier in converse session exchange in `backend/src/modules/settings/services/agentConverseSessionService.ts`
- [ ] T064 [US3] BLOCKED: Attribute MCP human-takeover/history provenance to end-user identity in `backend/src/modules/chat/services/agentConverseService.ts`

---

## Final Phase: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, generated artifacts, final verification, and release readiness.

- [ ] T065 [P] Update MCP client setup docs for converse grants, launch-token exchange, OAuth, resources, and rejected token classes in `docs/mcp-client-setup.md`
- [ ] T066 [P] Update MCP package README for public converse vs trusted workspace-token/stdio modes in `packages/radioso-mcp-server/README.md`
- [ ] T067 [P] Update SDK/API docs that mention MCP setup or generated contract use in `docs/typescript-sdk-basic-usage.md`
- [ ] T068 Update `readme.md` only if common Docker run flow, authentication setup, or operator-facing MCP setup changes
- [ ] T069 Run focused verification without `pnpm run build` in this sandbox: backend targeted tests, MCP package tests, OpenAPI contract check, and quickstart walkthrough from `specs/098-mcp-agent-converse/quickstart.md`
- [ ] T070 Update final validation notes for observability, message-queue impact, generated OpenAPI/SDK/MCP artifacts, docs updates, US3 blocked status, and local CI limitations in `specs/098-mcp-agent-converse/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup (Phase 1): no dependencies.
- Foundational (Phase 2): depends on setup and blocks all active user stories.
- US1 (Phase 3): depends on foundation and is the MVP.
- US2 (Phase 4): depends on US1 session/auth and permission foundation.
- US4 (Phase 5): depends on US1 session issuer and validation semantics.
- US3 deferred phase: blocked until spec 097 / PR #783 merges to `main`.
- Polish: depends on completed active story scope.

### User Story Dependencies

- US1 (P1): no story dependency after foundation.
- US2 (P2): depends on US1 session validation and `agent` role permissions.
- US4 (P3): depends on US1 session issuer and grant revalidation.
- US3 (P2): blocked; not active work.

### Parallel Opportunities

- Setup reading tasks T002-T006 can run in parallel.
- Foundational tests T007-T011 can run in parallel before implementation.
- US1 tests T022-T027 can run in parallel before US1 implementation.
- US2 tests T039-T042 can run in parallel after US1 is available.
- US4 tests T051-T053 can run in parallel after US1 session semantics are stable.
- Documentation tasks T065-T067 can run in parallel after active contract names stabilize.

## Parallel Example: US1

```text
Task: "T022 Contract tests for exchange, validate, ask in backend/tests/contract/mcp-converse.contract.test.ts"
Task: "T023 Integration test for launch exchange plus two-turn continuity in backend/tests/integration/mcp-converse.integration.test.ts"
Task: "T024 Integration tests for workspace/embed/public-link rejection in backend/tests/integration/mcp-converse-auth.integration.test.ts"
Task: "T025 Integration tests for grant revalidation in backend/tests/integration/mcp-converse-session-revalidation.integration.test.ts"
Task: "T026 MCP package tool-denial tests in packages/radioso-mcp-server/tests/converseTools.test.ts"
Task: "T027 MCP backend adapter tests in packages/radioso-mcp-server/tests/converseApiAdapter.test.ts"
```

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational tasks.
2. Complete US1 tests and implementation.
3. Stop and validate US1 independently using `quickstart.md`.

### Incremental Delivery

1. US1 proves the secure per-agent conversation loop.
2. US2 adds agent-aware read-only evidence.
3. US4 adds OAuth as an alternate front door over the same authority.
4. US3 waits for spec 097 and is explicitly excluded from active implementation.

### Contract Discipline

- Backend HTTP source of truth is `backend/src/app/http/openapi/document.ts`.
- Generated `backend/openapi.yaml` and `backend/openapi.json` are not hand-edited.
- MCP and SDK generated types sync after every backend contract change.
- Message-queue impact review must be recorded even if the conclusion is "no queue changes."
