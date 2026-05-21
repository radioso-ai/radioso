# Tasks: MCP Server Deployment Modes

**Input**: Design documents from `/specs/061-mcp-deployment-modes/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and come before implementation. Frontend tests cover mode-selection logic only.

> **Amendment 2026-05-19**: Task T017 ("Verify standalone `/v1/auth/exchange`, `/v1/approvals`, and `/mcp` tests still pass") was superseded by approval removal: `/v1/approvals` no longer exists; the equivalent verification covers `/v1/auth/exchange` and `/mcp` only.

## Phase 1: Setup

- [X] T001 Update `specs/061-mcp-deployment-modes/spec.md` status to approved.
- [X] T002 [P] Add planning artifacts in `specs/061-mcp-deployment-modes/plan.md`, `research.md`, `data-model.md`, `quickstart.md`, and `contracts/mcp-transport.md`.
- [X] T003 Add `@radioso/mcp-server` as a workspace dependency in `backend/package.json`.

## Phase 2: Foundational

- [X] T004 [P] Add MCP package request-handler tests in `packages/radioso-mcp-server/tests/requestHandler.test.ts`.
- [X] T005 [P] Add backend env/config tests for `RADIOSO_MCP_ENABLED` and `RADIOSO_MCP_STANDALONE`, `RADIOSO_MCP_MOUNT_PATH`, and CORS in `backend/tests/unit/runtime-config.test.ts`.
- [X] T006 [P] Add backend merged mount integration tests in `backend/tests/integration/mcp-merged-mode.integration.test.ts`.
- [X] T007 [P] Add frontend mode-selection tests in `frontend/tests/unit/mcp-channel-card.test.tsx`.

## Phase 3: User Story 1 - Single-Host Deployment (Priority: P1) MVP

**Goal**: Backend serves `/mcp` directly and accepts workspace API tokens.

**Independent Test**: `RADIOSO_MCP_ENABLED=true` with `RADIOSO_MCP_STANDALONE=false` backend accepts a workspace token for `tools/list` without `/v1/auth/exchange`.

- [X] T008 [US1] Extract shared MCP request-handler factory in `packages/radioso-mcp-server/src/http/requestHandler.ts`.
- [X] T009 [US1] Add Express adapter helper in `packages/radioso-mcp-server/src/http/expressAdapter.ts`.
- [X] T010 [US1] Refactor standalone HTTP routing in `packages/radioso-mcp-server/src/http/createHttpServer.ts` and `packages/radioso-mcp-server/src/http/mcpRoutes.ts` to use the shared handler.
- [X] T011 [US1] Export handler and adapter from `packages/radioso-mcp-server/src/index.ts`.
- [X] T012 [US1] Add backend MCP env parsing in `backend/src/app/config/env.ts`.
- [X] T013 [US1] Implement backend merged verifier and mount builder in `backend/src/app/server/mcpMount.ts`.
- [X] T014 [US1] Mount merged MCP before API routes in `backend/src/app/server/createApp.ts`.
- [X] T015 [US1] Add MCP mount status to backend `/health` in `backend/src/app/http/routes/index.ts`.
- [X] T016 [US1] Update dashboard same-host instructions in `frontend/components/dashboard/settings/mcp-channel-card.tsx`.

## Phase 4: User Story 2 - Standalone Deployment (Priority: P2)

**Goal**: Existing standalone deployment and exchange flow remain unchanged.

**Independent Test**: Existing MCP standalone tests and smoke commands keep passing.

- [X] T017 [US2] Verify standalone `/v1/auth/exchange`, `/v1/approvals`, and `/mcp` tests still pass in `packages/radioso-mcp-server/tests/`.
- [X] T018 [US2] Preserve remote setup dashboard instructions for cross-origin `NEXT_PUBLIC_MCP_URL` in `frontend/components/dashboard/settings/mcp-channel-card.tsx`.

## Phase 5: User Story 3 - Hybrid Deployment (Priority: P3)

**Goal**: Merged and standalone modes can run against the same backend and shared Redis store.

**Independent Test**: Both entry points use the same policy and audit layer; Redis-backed standalone state remains unchanged.

- [X] T019 [US3] Ensure merged mode reuses `RADIOSO_MCP_REDIS_URL`, policy, signing, and audit config in `backend/src/app/server/mcpMount.ts`.
- [X] T020 [US3] Add audit entry-point metadata for merged versus standalone in package audit events.

## Phase 6: Polish & Cross-Cutting

- [X] T021 [P] Update `.env.example` with merged mode env vars.
- [X] T022 [P] Update `readme.md`, `docs/mcp-client-setup.md`, and `packages/radioso-mcp-server/README.md`.
- [X] T023 Run `pnpm --dir packages/radioso-mcp-server test`.
- [X] T024 Run targeted backend tests for runtime config and merged MCP mode.
- [X] T025 Run targeted frontend tests for MCP channel card behavior.

## Dependencies & Execution Order

- Phase 1 precedes all implementation.
- Phase 2 tests precede code changes.
- US1 is the MVP and must land before US2/US3 verification.
- US2 is primarily regression preservation after shared-handler extraction.
- US3 depends on shared config reuse from US1.

## Implementation Strategy

Build the shared package handler first, then wire backend merged mode as a thin adapter. After the backend path works, update dashboard guidance and docs. Keep standalone behavior covered by existing tests throughout.
