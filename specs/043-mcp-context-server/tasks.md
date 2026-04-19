# Tasks: MCP Context Server

**Input**: Design documents from `/specs/043-mcp-context-server/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tool-catalog.md, quickstart.md

**Tests**: Backend and package-level tests are REQUIRED. Write failing tests before implementation for each backend-affecting or package-domain slice.

**Organization**: Tasks are grouped by user story to preserve the standalone package boundary and enable independently testable increments.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the standalone package scaffold and planning artifacts required for implementation.

- [x] T001 Create `packages/radioso-mcp-server/package.json`, `packages/radioso-mcp-server/tsconfig.json`, and `packages/radioso-mcp-server/tsconfig.build.json`
- [x] T002 Create package source structure in `packages/radioso-mcp-server/src/cli`, `packages/radioso-mcp-server/src/tools`, and `packages/radioso-mcp-server/tests`
- [x] T003 [P] Update agent context from the approved plan with `.specify/scripts/bash/update-agent-context.sh codex`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the standalone runtime seam and shared adapter abstractions before any tool-specific work starts.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 [P] Add failing package tests for configuration loading and adapter boundary behavior in `packages/radioso-mcp-server/tests/config.test.ts` and `packages/radioso-mcp-server/tests/radiosoApiAdapter.test.ts`
- [x] T005 [P] Implement environment config loading in `packages/radioso-mcp-server/src/config.ts`
- [x] T006 Implement the Radioso API adapter interface and SDK-backed implementation in `packages/radioso-mcp-server/src/radiosoApiAdapter.ts`
- [x] T007 Implement shared MCP result formatting helpers in `packages/radioso-mcp-server/src/toolResult.ts`
- [x] T008 Implement server bootstrap and tool registration wiring in `packages/radioso-mcp-server/src/server.ts`
- [x] T009 Implement the stdio CLI entrypoint in `packages/radioso-mcp-server/src/cli/stdio.ts`

**Checkpoint**: Standalone package can start and shared infrastructure is ready for read/write tool delivery.

---

## Phase 3: User Story 1 - Connect Any MCP Client To Workspace Knowledge (Priority: P1) 🎯 MVP

**Goal**: Deliver workspace-scoped MCP read tools for grounded context access.

**Independent Test**: Start the package through stdio, call capability discovery plus read tools, and confirm the results remain workspace-scoped and grounded.

### Tests for User Story 1 (REQUIRED)

- [x] T010 [P] [US1] Add failing read-tool tests in `packages/radioso-mcp-server/tests/readTools.test.ts`
- [x] T011 [P] [US1] Add failing grounded-answer formatting assertions in `packages/radioso-mcp-server/tests/readTools.test.ts`

### Implementation for User Story 1

- [x] T012 [P] [US1] Implement `describe_capabilities` and `list_documents` in `packages/radioso-mcp-server/src/tools/readTools.ts`
- [x] T013 [P] [US1] Implement `get_document` and `search_documents` in `packages/radioso-mcp-server/src/tools/readTools.ts`
- [x] T014 [US1] Implement `answer_grounded` in `packages/radioso-mcp-server/src/tools/readTools.ts`
- [x] T015 [US1] Implement `get_retrieval_settings` in `packages/radioso-mcp-server/src/tools/readTools.ts`
- [x] T016 [US1] Register read tools from `packages/radioso-mcp-server/src/server.ts`

**Checkpoint**: MCP read path is fully functional and independently testable.

---

## Phase 4: User Story 2 - Let Agents Maintain Workspace Content Through MCP (Priority: P1)

**Goal**: Deliver document and retrieval-settings write tools through the standalone package.

**Independent Test**: Use the MCP server to create, update, reprocess, and delete a document plus patch retrieval settings for the same workspace without opening the web app.

### Tests for User Story 2 (REQUIRED)

- [x] T017 [P] [US2] Add failing document-write tool tests in `packages/radioso-mcp-server/tests/writeTools.test.ts`
- [x] T018 [P] [US2] Add failing retrieval-settings patch tests in `packages/radioso-mcp-server/tests/writeTools.test.ts`

### Implementation for User Story 2

- [x] T019 [P] [US2] Implement `create_document` and `update_document` in `packages/radioso-mcp-server/src/tools/writeTools.ts`
- [x] T020 [P] [US2] Implement `delete_document` and `reprocess_document` in `packages/radioso-mcp-server/src/tools/writeTools.ts`
- [x] T021 [US2] Implement `update_retrieval_settings` patch-merge behavior in `packages/radioso-mcp-server/src/tools/writeTools.ts`
- [x] T022 [US2] Register write tools from `packages/radioso-mcp-server/src/server.ts`

**Checkpoint**: MCP write path is fully functional and independently testable.

---

## Phase 5: User Story 3 - Run The MCP Server As A Separate Product Surface (Priority: P1)

**Goal**: Make the package runnable and buildable without introducing backend-to-MCP dependencies.

**Independent Test**: Build the package and the backend separately, then verify the backend does not import or require MCP runtime code.

### Tests for User Story 3 (REQUIRED)

- [x] T023 [P] [US3] Add failing package smoke tests for server startup and tool registration in `packages/radioso-mcp-server/tests/server.test.ts`
- [x] T024 [P] [US3] Add failing boundary regression assertions in `packages/radioso-mcp-server/tests/server.test.ts`

### Implementation for User Story 3

- [x] T025 [US3] Finalize package exports and scripts in `packages/radioso-mcp-server/package.json`
- [x] T026 [US3] Ensure build-time dependency handling for the standalone MCP package in `packages/radioso-mcp-server/package.json` and `packages/radioso-mcp-server/tsconfig.build.json`
- [x] T027 [US3] Add package usage documentation in `packages/radioso-mcp-server/README.md`

**Checkpoint**: The standalone package boundary is explicit and testable.

---

## Phase 6: User Story 4 - Fail Safely For Invalid Auth, Scope, Or Tool Use (Priority: P2)

**Goal**: Return structured, safe failures for invalid credentials, malformed payloads, and unsupported capabilities.

**Independent Test**: Exercise covered failure cases and confirm the package returns structured errors rather than crashing or leaking cross-workspace information.

### Tests for User Story 4 (REQUIRED)

- [x] T028 [P] [US4] Add failing safe-error tests in `packages/radioso-mcp-server/tests/radiosoApiAdapter.test.ts`
- [x] T029 [P] [US4] Add failing unsupported-capability tests in `packages/radioso-mcp-server/tests/radiosoApiAdapter.test.ts`

### Implementation for User Story 4

- [x] T030 [US4] Implement tool-level error mapping in `packages/radioso-mcp-server/src/errors.ts`
- [x] T031 [US4] Integrate structured error handling into `packages/radioso-mcp-server/src/tools/readTools.ts`, `packages/radioso-mcp-server/src/tools/writeTools.ts`, and `packages/radioso-mcp-server/src/server.ts`

**Checkpoint**: Failure paths are safe and independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finish docs, run validation, and confirm merge readiness.

- [x] T032 [P] Update repo-level documentation for MCP usage in `readme.md`
- [ ] T033 [P] Update setup guidance or env examples if configuration changes in `backend/.env.example`
- [x] T034 Run package tests in `packages/radioso-mcp-server`
- [ ] T035 Run relevant SDK tests in `typescript-sdk`
- [ ] T036 Run relevant backend tests in `backend`
- [x] T037 Run the quickstart validation from `specs/043-mcp-context-server/quickstart.md`
- [x] T038 Perform senior engineer review, fix findings, and capture validation evidence in `specs/043-mcp-context-server/tasks.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all story work.
- **User Stories (Phases 3-6)**: Depend on Foundational completion.
- **Polish (Phase 7)**: Depends on all implemented user stories.

### User Story Dependencies

- **US1**: Starts after Foundational and defines the MVP read path.
- **US2**: Starts after Foundational and can proceed after or alongside US1, but benefits from the shared adapter and result formatting completed earlier.
- **US3**: Starts after Foundational and should land before final docs and QA.
- **US4**: Starts after the core read/write tools exist.

### Within Each User Story

- Tests fail first.
- Tool modules land before registration wiring.
- Shared adapter changes precede tool behavior that depends on them.
- Docs and validation close the loop after implementation.

### Parallel Opportunities

- Phase 1 task T003 can run alongside package scaffolding.
- In US1, list/get/search work can be developed in parallel with grounded-answer work after the shared adapter exists.
- In US2, document CRUD tasks can run in parallel with retrieval-settings patch work once the write-tool scaffold exists.
- In US4, error classification and error wiring can be split across files after the error contract is agreed.

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational work.
2. Deliver US1 read tools.
3. Validate the standalone read path through stdio before expanding.

### Incremental Delivery

1. Add read tools.
2. Add write tools.
3. Harden package boundary and startup ergonomics.
4. Add explicit safe-failure behavior.
5. Finish docs and QA.

### Review Strategy

1. Keep tasks updated as slices land.
2. Run targeted validation after each story.
3. Perform senior engineer review before final manager pass.
