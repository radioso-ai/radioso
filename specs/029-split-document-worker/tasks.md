# Tasks: Split Document Worker Runtime

**Input**: Design documents from `/specs/029-split-document-worker/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend tests are REQUIRED and will be written before implementation tasks for each story.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., [US1], [US2], [US3])

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare delivery artifacts and runtime seams before feature work

- [X] T001 Create plan, research, data-model, and quickstart artifacts in specs/029-split-document-worker/
- [X] T002 Run `.specify/scripts/bash/update-agent-context.sh codex` from repository root

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared runtime seams before user-story implementation

- [X] T003 Add failing startup/runtime tests for role ownership, migration checks, and local orchestration in backend/tests/unit/runtime-startup.test.ts and backend/tests/integration/runtime-entrypoints.integration.test.ts
- [X] T004 Extract shared runtime bootstrap helpers in backend/src/runtime/
- [X] T005 Split backend entrypoints into API and worker roles in backend/src/httpServer.ts, backend/src/documentWorker.ts, and backend/src/index.ts
- [X] T006 Add explicit backend scripts and update dev entrypoint/orchestration wiring in backend/package.json, infra/backend.dev.entrypoint.sh, infra/docker-compose.dev.yml, and infra/docker-compose.yml

**Checkpoint**: Runtime seams and local process definitions exist; user stories can proceed.

---

## Phase 3: User Story 1 - Keep Chat Serving Independent From Ingestion (Priority: P1) 🎯 MVP

**Goal**: Make API and worker lifecycles independent while keeping HTTP serving and connector ownership with the API runtime.

**Independent Test**: Start the API role without the worker and confirm routes still serve; start the worker later and confirm it can run without the HTTP server.

### Tests for User Story 1

- [X] T007 [P] [US1] Add failing unit tests for API-owned migrations/connectors and worker fail-fast startup in backend/tests/unit/runtime-startup.test.ts
- [X] T008 [P] [US1] Add failing integration tests for API-only and worker-only entrypoints in backend/tests/integration/runtime-entrypoints.integration.test.ts

### Implementation for User Story 1

- [X] T009 [US1] Implement API runtime startup orchestration in backend/src/httpServer.ts and backend/src/runtime/startApiRuntime.ts
- [X] T010 [US1] Implement worker runtime startup orchestration and fail-fast pending-migration checks in backend/src/documentWorker.ts and backend/src/runtime/startWorkerRuntime.ts
- [X] T011 [US1] Add migration-state inspection helpers in backend/src/db/runMigrations.ts and backend/src/runtime/migrationState.ts
- [X] T012 [US1] Keep API-owned connector migration/init logic in backend/src/runtime/startApiRuntime.ts and ensure worker runtime does not boot connectors

**Checkpoint**: API and worker processes run independently with explicit ownership boundaries.

---

## Phase 4: User Story 2 - Preserve Existing Document Processing Behavior (Priority: P2)

**Goal**: Preserve current DB-backed job semantics while adding worker lifecycle and backlog observability.

**Independent Test**: Queue jobs, run only the worker role, and confirm successful processing, retries, restart recovery, and stale/deleted safeguards remain intact.

### Tests for User Story 2

- [X] T013 [P] [US2] Add failing worker-behavior regression tests in backend/tests/unit/document-processing-worker-runtime.test.ts
- [X] T014 [P] [US2] Add failing integration coverage for worker restart recovery and queue observability in backend/tests/integration/runtime-entrypoints.integration.test.ts

### Implementation for User Story 2

- [X] T015 [US2] Add queue snapshot and logging support in backend/src/db/repositories/documentProcessingJobRepository.ts and backend/src/modules/documents/services/documentProcessingWorker.ts
- [X] T016 [US2] Add role-specific lifecycle and backlog logs in backend/src/modules/documents/services/documentProcessingWorker.ts and backend/src/runtime/start*.ts
- [X] T017 [US2] Preserve existing worker retry/recovery behavior while wiring new runtime start/stop flow in backend/src/modules/documents/services/documentProcessingWorker.ts

**Checkpoint**: Worker semantics are preserved and operational signals are visible without changing API contracts.

---

## Phase 5: User Story 3 - Run Local Development With Explicit Runtime Roles (Priority: P3)

**Goal**: Make local development expose explicit API and worker services/commands.

**Independent Test**: Start full local orchestration and confirm separate backend/backend-worker roles; start each role independently with named scripts.

### Tests for User Story 3

- [X] T018 [P] [US3] Add failing local-orchestration assertions in backend/tests/unit/runtime-config.test.ts

### Implementation for User Story 3

- [X] T019 [US3] Update backend scripts and compatibility entrypoint docs in backend/package.json and specs/029-split-document-worker/quickstart.md
- [X] T020 [US3] Add explicit backend-worker service wiring in infra/docker-compose.dev.yml and infra/docker-compose.yml
- [X] T021 [US3] Update bootstrap/dev entrypoint behavior to support named backend roles in infra/backend.dev.entrypoint.sh and scripts/bootstrap/compose-runner.mjs if needed

**Checkpoint**: Local development supports API-only, worker-only, and combined startup paths.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T022 Regenerate task checkboxes and ensure completed tasks are marked in specs/029-split-document-worker/tasks.md
- [X] T023 Run targeted backend validation for runtime split behavior and document results in specs/029-split-document-worker/quickstart.md or PR notes
- [X] T024 Verify no backend HTTP contract changes were introduced; regenerate OpenAPI only if contract surfaces changed
- [X] T025 Review and update docs/config comments only if runtime commands or environment expectations changed

## Dependencies & Execution Order

### Phase Dependencies

- Setup (Phase 1): starts immediately
- Foundational (Phase 2): depends on setup, blocks all stories
- User Stories (Phases 3-5): depend on Foundational completion
- Polish (Phase 6): depends on all desired stories being complete

### User Story Dependencies

- **US1**: starts after Foundational; establishes the runtime split
- **US2**: depends on US1 entrypoints and shared runtime seams
- **US3**: depends on US1 scripts/entrypoints and can finish after orchestration changes

### Within Each User Story

- Tests first, ensure they fail
- Shared/runtime seam extraction before wiring orchestration
- Logging/observability after the owning startup flow exists
- Mark tasks complete as work lands

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver US1 with failing tests first and independent API/worker startup
3. Validate API-only and worker-only paths

### Incremental Delivery

1. Split entrypoints and ownership boundaries
2. Preserve worker semantics and add observability
3. Finish local orchestration and command polish

### Parallel Opportunities

- T007/T008 can be developed in parallel after foundational setup
- T013/T014 can be developed in parallel after US1 lands
- T019/T020 can proceed in parallel once runtime scripts are defined
