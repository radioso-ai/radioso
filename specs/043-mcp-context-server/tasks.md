# Tasks: Remote MCP Context Server

**Input**: Design documents from `/specs/043-mcp-context-server/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tool-catalog.md, contracts/remote-http.md, quickstart.md

> **Amendment 2026-05-19**: Tasks under Phase 4 (User Story 2) that build the `POST /v1/approvals` endpoint, the approval store, the `verifyApproval` flow, and the `approvalToken` argument on write tools have been superseded by the approval removal. The remaining authorization layers are: workspace API token, exchange-time `requestedTools` granting, capability-policy allowlist, and the upstream Radioso permission required by each REST route. Host-side prompting (Cursor / Claude Desktop / ChatGPT) is now the only human-in-the-loop gate for writes, driven by `requiresApproval: true` on the tool advertisement.

**Tests**: Package-level TDD is REQUIRED. Write failing tests before implementation for each auth, policy, transport, and tool slice.

**Organization**: Tasks are grouped by user story to preserve the extractable package boundary and enable independently testable increments.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Reorganize the existing package for remote-server delivery and refresh planning context.

- [x] T001 Create extraction-friendly source directories in `packages/radioso-mcp-server/src/audit`, `src/auth`, `src/http`, `src/policy`, and `src/transport`
- [x] T002 Update package dependencies, scripts, and bins for remote HTTP runtime in `packages/radioso-mcp-server/package.json`
- [x] T003 [P] Refresh TypeScript build inputs for new package modules in `packages/radioso-mcp-server/tsconfig.json` and `packages/radioso-mcp-server/tsconfig.build.json`
- [x] T004 [P] Update agent context from the approved plan with `.specify/scripts/bash/update-agent-context.sh codex`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the package-owned seams for remote auth, policy, approvals, audit, and transport before any user story work starts.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T005 [P] Add failing config coverage for remote-mode settings in `packages/radioso-mcp-server/tests/config.test.ts`
- [x] T006 [P] Add failing auth/session store tests in `packages/radioso-mcp-server/tests/auth.test.ts`
- [x] T007 [P] Add failing capability policy and approval tests in `packages/radioso-mcp-server/tests/policy.test.ts`
- [x] T008 [P] Add failing audit sink tests in `packages/radioso-mcp-server/tests/audit.test.ts`
- [x] T009 Implement remote-aware config loading in `packages/radioso-mcp-server/src/config.ts`
- [x] T010 Implement package-owned auth/session models and in-memory stores in `packages/radioso-mcp-server/src/auth/sessionStore.ts` and `packages/radioso-mcp-server/src/auth/approvalStore.ts`
- [x] T011 Implement auth exchange and approval services in `packages/radioso-mcp-server/src/auth/authService.ts`
- [x] T012 Implement capability policy registry and enforcement helpers in `packages/radioso-mcp-server/src/policy/capabilityPolicy.ts`
- [x] T013 Implement structured audit event contracts and sinks in `packages/radioso-mcp-server/src/audit/auditLogger.ts`
- [x] T014 Refactor the Radioso adapter to support session-bound upstream tokens in `packages/radioso-mcp-server/src/radiosoApiAdapter.ts`
- [x] T015 Refactor shared tool result and error helpers for auth/policy-aware execution in `packages/radioso-mcp-server/src/toolResult.ts` and `packages/radioso-mcp-server/src/errors.ts`

**Checkpoint**: The package has explicit auth, approval, policy, audit, and adapter seams ready for remote transport and tool execution.

---

## Phase 3: User Story 1 - Connect A Remote MCP Client To Workspace Knowledge (Priority: P1) 🎯 MVP

**Goal**: Deliver remote MCP transport, auth exchange, and session-scoped read tools.

**Independent Test**: Start the remote package, exchange a workspace token for an MCP access token, call the remote MCP endpoint with read tools, and confirm the results remain workspace-scoped and grounded.

### Tests for User Story 1 (REQUIRED)

- [x] T016 [P] [US1] Add failing remote auth exchange tests in `packages/radioso-mcp-server/tests/httpAuthExchange.test.ts`
- [x] T017 [P] [US1] Add failing remote MCP read transport tests in `packages/radioso-mcp-server/tests/httpReadTransport.test.ts`
- [x] T018 [P] [US1] Add failing session-scoped capability discovery tests in `packages/radioso-mcp-server/tests/readTools.test.ts`

### Implementation for User Story 1

- [x] T019 [P] [US1] Implement session-scoped read tool definitions in `packages/radioso-mcp-server/src/tools/readTools.ts`
- [x] T020 [US1] Implement remote HTTP auth routes in `packages/radioso-mcp-server/src/http/authRoutes.ts`
- [x] T021 [US1] Implement remote MCP HTTP handler wiring in `packages/radioso-mcp-server/src/http/mcpRoutes.ts`
- [x] T022 [US1] Implement remote server bootstrap and health endpoint in `packages/radioso-mcp-server/src/http/createHttpServer.ts`
- [x] T023 [US1] Add the HTTP CLI entrypoint in `packages/radioso-mcp-server/src/cli/http.ts`
- [x] T024 [US1] Register remote read-capable server wiring in `packages/radioso-mcp-server/src/server.ts` and `packages/radioso-mcp-server/src/index.ts`

**Checkpoint**: Remote read path is fully functional and independently testable.

---

## Phase 4: User Story 2 - Govern Remote Write Operations With Policy And Approval (Priority: P1)

**Goal**: Deliver approval-gated write tools through the remote package.

**Independent Test**: Exchange credentials, request an approval grant, perform allowed write tool calls, and confirm the same calls fail without valid approval.

### Tests for User Story 2 (REQUIRED)

- [x] T025 [P] [US2] Add failing approval issuance tests in `packages/radioso-mcp-server/tests/httpApprovals.test.ts`
- [x] T026 [P] [US2] Add failing governed write-tool tests in `packages/radioso-mcp-server/tests/writeTools.test.ts`
- [x] T027 [P] [US2] Add failing approval-expiry and approval-missing tests in `packages/radioso-mcp-server/tests/httpApprovals.test.ts`

### Implementation for User Story 2

- [x] T028 [P] [US2] Extend write tool schemas for approval-aware execution in `packages/radioso-mcp-server/src/tools/writeTools.ts`
- [x] T029 [P] [US2] Implement approval validation hooks for governed tools in `packages/radioso-mcp-server/src/policy/capabilityPolicy.ts`
- [x] T030 [US2] Implement approval route handling in `packages/radioso-mcp-server/src/http/authRoutes.ts`
- [x] T031 [US2] Register governed write tools in `packages/radioso-mcp-server/src/server.ts`

**Checkpoint**: Remote write path is governed, approval-aware, and independently testable.

---

## Phase 5: User Story 3 - Run The MCP Server As An Extractable Product Surface (Priority: P1)

**Goal**: Keep the package runnable, buildable, and extractable without backend-to-MCP dependencies.

**Independent Test**: Build the package, run the HTTP server, and verify the backend does not import or require package-owned transport/auth code.

### Tests for User Story 3 (REQUIRED)

- [x] T032 [P] [US3] Add failing package startup and boundary regression tests in `packages/radioso-mcp-server/tests/server.test.ts`
- [x] T033 [P] [US3] Add failing extractable-module smoke assertions in `packages/radioso-mcp-server/tests/server.test.ts`

### Implementation for User Story 3

- [x] T034 [P] [US3] Finalize package exports and dual CLI bins in `packages/radioso-mcp-server/package.json`
- [x] T035 [P] [US3] Finalize package module entrypoints in `packages/radioso-mcp-server/src/index.ts`
- [x] T036 [US3] Update package README for remote operation in `packages/radioso-mcp-server/README.md`

**Checkpoint**: The package boundary is explicit, runnable, and ready for later repo extraction.

---

## Phase 6: User Story 4 - Fail Safely And Leave Audit Evidence (Priority: P2)

**Goal**: Return structured, safe failures and produce package-owned audit evidence for auth, approval, and tool outcomes.

**Independent Test**: Exercise bad-token, expired-token, approval-missing, approval-expired, unsupported-capability, malformed-input, and cross-workspace access scenarios and confirm the server returns structured failures plus audit events.

### Tests for User Story 4 (REQUIRED)

- [x] T037 [P] [US4] Add failing safe-error mapping tests in `packages/radioso-mcp-server/tests/errors.test.ts`
- [x] T038 [P] [US4] Add failing audit-on-denial and audit-on-upstream-failure tests in `packages/radioso-mcp-server/tests/httpAudit.test.ts`

### Implementation for User Story 4

- [x] T039 [P] [US4] Implement remote error classification for auth, approval, policy, and upstream capability failures in `packages/radioso-mcp-server/src/errors.ts`
- [x] T040 [P] [US4] Integrate audit emission into auth exchange, approvals, and tool execution in `packages/radioso-mcp-server/src/auth/authService.ts`, `packages/radioso-mcp-server/src/http/authRoutes.ts`, and `packages/radioso-mcp-server/src/server.ts`
- [x] T041 [US4] Integrate structured remote failure responses in `packages/radioso-mcp-server/src/http/mcpRoutes.ts` and `packages/radioso-mcp-server/src/http/authRoutes.ts`

**Checkpoint**: Failure paths are safe, auditable, and independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finish docs, env setup, validation, and review loops.

- [x] T042 [P] Update repo-level documentation for remote MCP usage in `readme.md`
- [x] T043 [P] Update setup guidance and new remote env vars in `backend/.env.example`
- [x] T044 Run package tests in `packages/radioso-mcp-server`
- [x] T045 Run remote quickstart validation from `specs/043-mcp-context-server/quickstart.md`
- [x] T046 Perform senior engineer review, fix findings, and capture validation evidence in `specs/043-mcp-context-server/tasks.md`
- [x] T047 Perform QA validation on the remote MCP flow and fix any package-level issues surfaced by QA

---

## Phase 8: Criticism Response - Hosted Control-Plane Foundations

**Purpose**: Address the approved criticism by making the remote MCP surface more hostable, workspace-aware, and explicit about upstream capability support.

**⚠️ CRITICAL**: Backend contract tests and package tests MUST fail first before implementing the new control-plane slice.

### Tests for User Story 3 - Multi-Instance Runtime (REQUIRED)

- [ ] T048 [P] [US3] Add failing shared-store session and approval tests in `packages/radioso-mcp-server/tests/auth.test.ts` and new shared-store-specific test files under `packages/radioso-mcp-server/tests/`
- [ ] T049 [P] [US3] Add failing multi-instance remote flow tests in `packages/radioso-mcp-server/tests/httpSharedStore.test.ts`
- [ ] T050 [P] [US3] Add failing stateless remote transport regression tests in `packages/radioso-mcp-server/tests/server.test.ts`

### Implementation for User Story 3

- [ ] T051 [P] [US3] Implement package-owned shared-store adapters and configuration in `packages/radioso-mcp-server/src/state/*`, `src/config.ts`, and `src/cli/http.ts`
- [ ] T052 [P] [US3] Refactor remote request handling to avoid process-local session-only transport assumptions in `packages/radioso-mcp-server/src/http/sessionServerManager.ts`, `src/http/mcpRoutes.ts`, and `src/server.ts`
- [ ] T053 [US3] Update remote runtime docs and environment examples for shared-store mode in `packages/radioso-mcp-server/README.md`, `backend/.env.example`, and `readme.md`

**Checkpoint**: The remote MCP runtime can operate in both single-node local mode and shared-store multi-instance mode.

---

## Phase 9: Criticism Response - Workspace Policy And Capability Negotiation

**Purpose**: Make the MCP surface adapt to workspace policy and upstream backend capability/version differences before clients execute tools.

### Tests for User Story 4 (REQUIRED)

- [ ] T054 [P] [US4] Add failing backend contract tests for workspace MCP context in `backend/tests/`
- [ ] T055 [P] [US4] Add failing package capability-negotiation tests in `packages/radioso-mcp-server/tests/httpAuthExchange.test.ts`, `tests/readTools.test.ts`, and new policy-specific test files as needed
- [ ] T056 [P] [US4] Add failing workspace policy override tests in `packages/radioso-mcp-server/tests/policy.test.ts`

### Implementation for User Story 4

- [ ] T057 [P] [US4] Implement the backend workspace MCP context route and regenerate OpenAPI artifacts in `backend/src/app/http/routes/*`, `backend/src/app/http/openapi/document.ts`, `backend/openapi.yaml`, and `backend/openapi.json`
- [ ] T058 [P] [US4] Extend the Radioso API adapter with workspace context and capability/version probing in `packages/radioso-mcp-server/src/radiosoApiAdapter.ts` and related types
- [ ] T059 [P] [US4] Implement workspace-specific policy override resolution in `packages/radioso-mcp-server/src/policy/*` and `src/config.ts`
- [ ] T060 [US4] Intersect global policy, workspace policy, and upstream capability support during exchange and capability discovery in `packages/radioso-mcp-server/src/auth/authService.ts`, `src/tools/readTools.ts`, and `src/http/*`

**Checkpoint**: The server exposes only the tools that are both allowed for the workspace and supported by the current Radioso deployment.

---

## Phase 10: Follow-Through Validation

**Purpose**: Re-run manager-quality validation on the criticism-response scope.

- [ ] T061 [P] Run backend and package tests covering the new shared-store and capability-negotiation scope
- [ ] T062 [P] Run two-instance manual smoke validation for exchange, `tools/list`, approval issuance, and approved write across instances
- [ ] T063 Perform senior engineer review on the criticism-response slice and fix findings
- [ ] T064 Perform QA validation on the expanded remote MCP flow and document residual hosted-control-plane risks

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all story work.
- **User Stories (Phases 3-6)**: Depend on Foundational completion.
- **Polish (Phase 7)**: Depends on all originally approved user stories.
- **Criticism Response (Phases 8-9)**: Depends on the remote MVP from Phases 3-6 and adds new backend/package tests before implementation.
- **Follow-Through Validation (Phase 10)**: Depends on Phases 8-9.

### User Story Dependencies

- **US1**: Starts after Foundational and defines the MVP remote read path.
- **US2**: Starts after Foundational and depends on US1 remote auth/session flow.
- **US3**: The criticism-response multi-instance runtime starts after the remote MVP exists.
- **US4**: The criticism-response capability-negotiation work starts after the remote MVP exists and depends on one additive backend contract.

### Within Each User Story

- Tests fail first.
- Auth, policy, and audit seams land before route handlers that depend on them.
- Transport wiring lands before full quickstart validation.
- Docs and validation close the loop after implementation.

### Parallel Opportunities

- Phase 2 test tasks T005-T008 can run in parallel.
- In US1, auth-route tests, transport tests, and read-tool tests can run in parallel before implementation.
- In US2, approval issuance and governed write-tool tests can run in parallel before approval-aware implementations.
- In US3, package export and README updates can run after the entrypoint shape is stable.
- In the criticism-response slice, shared-store tests and backend-context contract tests can run in parallel before implementation.

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational work.
2. Deliver US1 remote auth exchange and read tools.
3. Validate the remote read path before expanding writes.

### Incremental Delivery

1. Reorganize the package for extractability.
2. Add auth exchange, access sessions, and remote transport.
3. Add approval-gated write tools.
4. Harden failure behavior and audit logging.
5. Add shared-store hosting support and remove process-local remote assumptions.
6. Add workspace policy and upstream capability negotiation.
7. Finish docs, review, and QA.

### Review Strategy

1. Keep tasks updated as slices land.
2. Run targeted validation after each story.
3. Perform senior engineer review before final manager and QA passes.

## Validation Evidence

- `npm test` in `packages/radioso-mcp-server` passed with 14 test files and 34 tests on 2026-04-21 after the remote hardening fixes.
- `npm run build` in `packages/radioso-mcp-server` passed on 2026-04-21 after the TypeScript input refresh and remote error-boundary changes.
- Manual end-to-end remote smoke against the built HTTP server passed on 2026-04-21, covering bad-token exchange rejection, session initialization, `tools/list`, approval-required write denial, approval issuance, and approved `create_document`.
