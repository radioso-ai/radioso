# Tasks: Autoscaled Workers

**Input**: Design documents from `/specs/042-autoscale-workers/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend tests are REQUIRED and must be written before implementation tasks for each user story.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (for example, `[US1]`)

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare delivery artifacts and agent context before implementation

- [X] T001 Create or refresh planning artifacts in specs/042-autoscale-workers/plan.md, specs/042-autoscale-workers/research.md, specs/042-autoscale-workers/data-model.md, specs/042-autoscale-workers/quickstart.md, and specs/042-autoscale-workers/tasks.md
- [X] T002 Run `.specify/scripts/bash/update-agent-context.sh codex` from /Users/dm/conductor/workspaces/radioso/louisville

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared dispatch and worker-runtime seams before story implementation

- [X] T003 Add failing unit coverage for dispatch configuration and worker task startup in backend/tests/unit/runtime-startup.test.ts and backend/tests/unit/runtime-config.test.ts
- [X] T004 [P] Add failing repository and worker-task behavior coverage for claim-by-id, lease recovery, and duplicate-delivery handling in backend/tests/unit/document-ingestion.test.ts and backend/tests/unit/document-processing-worker-runtime.test.ts
- [X] T005 [P] Add failing integration coverage for internal worker task HTTP handling and runtime entrypoints in backend/tests/integration/runtime-entrypoints.integration.test.ts and backend/tests/integration/persistence.integration.test.ts
- [X] T006 Extract shared document-job dispatch and task-processing seams in backend/src/modules/documents/services/ and backend/src/modules/documents/infra/
- [X] T007 Add dedicated request-driven worker runtime wiring in backend/src/app/worker/, backend/src/runtime/, and backend/src/documentWorkerServer.ts

**Checkpoint**: Shared seams exist for dispatch, task handling, and worker runtime composition.

---

## Phase 3: User Story 1 - Process document backlogs without manual intervention (Priority: P1) 🎯 MVP

**Goal**: Dispatch durable document jobs to autoscaled workers while preserving job ownership in PostgreSQL.

**Independent Test**: Queue multiple document jobs, trigger worker task delivery, and verify each job is claimed at most once while duplicate delivery remains safe.

### Tests for User Story 1

- [X] T008 [P] [US1] Add failing unit tests for dispatch-on-enqueue and dispatch-on-requeue behavior in backend/tests/unit/document-ingestion.test.ts and backend/tests/unit/document-import-service.test.ts
- [X] T009 [P] [US1] Add failing unit tests for claim-by-id and duplicate-delivery no-op behavior in backend/tests/unit/document-processing-worker-runtime.test.ts

### Implementation for User Story 1

- [X] T010 [US1] Add dispatch configuration env parsing in backend/src/app/config/env.ts and backend/.env.example
- [X] T011 [US1] Implement document-job dispatch ports and Cloud Tasks/noop implementations in backend/src/modules/documents/services/documentJobDispatcher.ts and backend/src/modules/documents/infra/cloudTasksDocumentJobDispatcher.ts
- [X] T012 [US1] Extend durable job repository support for find-by-id, claim-by-id, and queued-job lookup in backend/src/db/repositories/documentProcessingJobRepository.ts and backend/tests/support/fakes.ts
- [X] T013 [US1] Dispatch queued jobs from backend/src/modules/documents/services/documentIngestionService.ts, backend/src/modules/documents/services/documentImportService.ts, and backend/src/modules/documents/services/workspaceIngestionReprocessService.ts
- [X] T014 [US1] Wire dispatch dependencies through backend/src/app/server/dependencies.ts and backend/src/app/server/types.ts

**Checkpoint**: Queued jobs produce request-driven worker dispatch while durable claim ownership remains in PostgreSQL.

---

## Phase 4: User Story 2 - Keep chat responsive while document work is busy (Priority: P1)

**Goal**: Run document work on a dedicated autoscaled worker runtime while keeping backend-serving scale independent for chat traffic.

**Independent Test**: Start the worker HTTP runtime separately from the API runtime and confirm queued jobs can be processed without booting the customer-facing API routes.

### Tests for User Story 2

- [X] T015 [P] [US2] Add failing runtime tests for worker HTTP startup and dedicated health/task routing in backend/tests/unit/runtime-startup.test.ts and backend/tests/integration/runtime-entrypoints.integration.test.ts
- [X] T016 [P] [US2] Add failing infrastructure configuration assertions for independent backend and worker scaling bounds in backend/tests/unit/runtime-config.test.ts

### Implementation for User Story 2

- [X] T017 [US2] Implement the internal worker task app and route handling in backend/src/app/worker/createWorkerTaskApp.ts and backend/src/app/worker/workerTaskRoutes.ts
- [X] T018 [US2] Implement request-driven worker runtime startup and entrypoint wiring in backend/src/runtime/startWorkerTaskRuntime.ts and backend/src/documentWorkerServer.ts
- [X] T019 [US2] Add worker task handling and response mapping for lease-aware retries in backend/src/modules/documents/services/documentProcessingWorker.ts or extracted shared helpers
- [X] T020 [US2] Update backend/package.json and infra/terraform/compute.tf, infra/terraform/variables.tf, and infra/terraform/terraform.tfvars.example for independent backend and worker runtime commands/scaling

**Checkpoint**: Worker task processing runs in its own runtime with scaling controls separated from chat-serving capacity.

---

## Phase 5: User Story 3 - Operate scaling safely with clear signals (Priority: P2)

**Goal**: Make retries, stale-claim recovery, and backlog health observable and safe under worker interruption.

**Independent Test**: Force duplicate delivery and interrupted-worker scenarios, then confirm lease recovery, retry scheduling, and terminal outcomes are visible and correct.

### Tests for User Story 3

- [X] T021 [P] [US3] Add failing unit tests for stale-claim recovery and retry scheduling in backend/tests/unit/document-processing-worker-runtime.test.ts
- [X] T022 [P] [US3] Add failing integration tests for worker interruption recovery and queued backlog observability in backend/tests/integration/persistence.integration.test.ts and backend/tests/integration/runtime-entrypoints.integration.test.ts

### Implementation for User Story 3

- [X] T023 [US3] Implement lease-aware claim recovery and retry redispatch in backend/src/db/repositories/documentProcessingJobRepository.ts and backend/src/modules/documents/services/documentProcessingWorker.ts
- [X] T024 [US3] Add Cloud Tasks queue resources and invoker/dispatcher IAM wiring in infra/terraform/apis.tf, infra/terraform/queue.tf, infra/terraform/compute.tf, and infra/terraform/outputs.tf
- [X] T025 [US3] Update operational documentation and validation steps in readme.md and specs/042-autoscale-workers/quickstart.md

**Checkpoint**: Backlog processing, duplicate delivery, and failover behavior are observable and safe.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T026 Regenerate completion state in specs/042-autoscale-workers/tasks.md as work lands
- [X] T027 Run targeted backend validation with `npm run test:unit`, `npm run test:integration`, and any focused runtime/persistence test subsets in /Users/dm/conductor/workspaces/radioso/louisville/backend
- [X] T028 Verify no public OpenAPI contract surface changed; regenerate backend OpenAPI only if a public API route changed
- [X] T029 Review environment and deployment docs for new worker-dispatch settings in backend/.env.example, infra/terraform/terraform.tfvars.example, and readme.md

## Dependencies & Execution Order

### Phase Dependencies

- Phase 1 starts immediately
- Phase 2 depends on Phase 1 and blocks all user stories
- Phase 3 depends on Phase 2
- Phase 4 depends on Phase 2 and reuses the Phase 3 dispatch seam
- Phase 5 depends on Phases 3 and 4
- Phase 6 depends on all desired user stories being complete

### User Story Dependencies

- **US1** establishes durable dispatch and claim-by-id semantics
- **US2** depends on US1 dispatch inputs and adds the worker HTTP runtime plus scaling separation
- **US3** depends on US1/US2 and completes observability plus failover safety

### Within Each User Story

- Backend tests must fail before implementation
- Repository and service seams land before runtime wiring
- Runtime wiring lands before Terraform rollout changes
- Docs and validation close the loop after code is stable

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver US1 durable dispatch and claim-by-id behavior
3. Deliver US2 worker runtime separation and scaling controls
4. Validate request-driven processing before adding failover polish

### Incremental Delivery

1. Add dispatch and durable claim seams
2. Add worker HTTP runtime and independent scaling controls
3. Add lease recovery, retry redispatch, and observability

### Parallel Opportunities

- T004 and T005 can proceed in parallel after setup
- T008 and T009 can proceed in parallel within US1
- T015 and T016 can proceed in parallel within US2
- T021 and T022 can proceed in parallel within US3
