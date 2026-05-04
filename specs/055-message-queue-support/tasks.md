# Tasks: Message Queue Support

**Input**: Design documents from `/specs/055-message-queue-support/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/document-job-message.md, quickstart.md

**Tests**: Backend tests are REQUIRED and MUST be written before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Architecture**: Broker-specific behavior stays in document infrastructure adapters. Product services depend only on dispatcher/consumer ports. Application composition/runtime owns default adapter selection and lifecycle wiring.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the AMQP client dependency and shared queue contracts.

- [X] T001 Add `amqplib` and TypeScript types to `backend/package.json` and `backend/package-lock.json`
- [X] T002 [P] Define document queue message schema helpers in `backend/src/modules/documents/services/documentJobMessage.ts`
- [X] T003 [P] Define `DocumentJobConsumerPort` in `backend/src/modules/documents/services/documentJobConsumer.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Configuration and composition seams required before user stories.

- [X] T004 [P] Write failing config validation tests for AMQP settings in `backend/tests/unit/runtime-config.test.ts`
- [X] T005 [P] Write failing composition tests for AMQP dispatcher/consumer selection in `backend/tests/unit/default-composition.test.ts`
- [X] T006 Extend `WORKER_DISPATCH_DRIVER` and AMQP environment parsing in `backend/src/app/config/env.ts`
- [X] T007 Extend composition types and helper signatures for optional document job consumers in `backend/src/app/composition/applicationModule.ts` and `backend/src/app/composition/defaultComposition.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Dispatch Document Work Through a Message Queue (Priority: P1) MVP

**Goal**: Publish durable AMQP messages for document job dispatch.

**Independent Test**: Unit test proves the dispatcher asserts a durable queue and sends persistent JSON messages with the durable job id.

### Tests for User Story 1

- [X] T008 [P] [US1] Write failing AMQP dispatcher unit tests in `backend/tests/unit/amqp-document-job-queue.test.ts`

### Implementation for User Story 1

- [X] T009 [US1] Implement AMQP dispatch behavior in `backend/src/modules/documents/infra/amqpDocumentJobQueue.ts`
- [X] T010 [US1] Wire AMQP dispatch selection in `backend/src/app/composition/defaultComposition.ts`
- [X] T011 [US1] Run AMQP dispatcher and config tests from `backend/`

**Checkpoint**: AMQP publish path works independently.

---

## Phase 4: User Story 2 - Consume Broker Messages in the Worker (Priority: P2)

**Goal**: Worker consumes AMQP messages and delegates to existing job-by-id processing.

**Independent Test**: Unit test proves valid messages call `runJobById`, malformed messages are acknowledged, and busy jobs are requeued.

### Tests for User Story 2

- [X] T012 [P] [US2] Write failing AMQP consumer unit tests in `backend/tests/unit/amqp-document-job-queue.test.ts`
- [X] T013 [P] [US2] Write failing worker runtime lifecycle tests in `backend/tests/unit/document-processing-worker-runtime.test.ts`

### Implementation for User Story 2

- [X] T014 [US2] Implement AMQP consumer behavior in `backend/src/modules/documents/infra/amqpDocumentJobQueue.ts`
- [X] T015 [US2] Add optional document job consumer to `AppDependencies` and build it in `backend/src/app/server/dependencies.ts`
- [X] T016 [US2] Start and stop the optional consumer in `backend/src/runtime/startWorkerRuntime.ts` and `backend/src/runtime/startWorkerTaskRuntime.ts`
- [X] T017 [US2] Run AMQP consumer and runtime lifecycle tests from `backend/`

**Checkpoint**: Worker consume path works independently.

---

## Phase 5: User Story 3 - Operate and Document Queue Configuration (Priority: P3)

**Goal**: Operators can configure and understand queue mode safely.

**Independent Test**: `.env.example` and docs describe required settings and startup validation catches missing settings.

### Tests for User Story 3

- [X] T018 [P] [US3] Add/update docs/config assertions in `backend/tests/unit/runtime-config.test.ts`

### Implementation for User Story 3

- [X] T019 [US3] Update AMQP settings in `backend/.env.example`
- [X] T020 [US3] Read `docs/document-writer-prompt.md` before editing product docs
- [X] T021 [US3] Update worker dispatch documentation in `readme.md`
- [X] T022 [US3] Update extension point documentation in `docs/architecture-extension-points.md`
- [X] T023 [US3] Run docs/config focused validation from `backend/`

**Checkpoint**: Queue mode is operable and documented.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and artifact sync.

- [X] T024 Update `specs/055-message-queue-support/quickstart.md` if implementation details differ from the plan
- [X] T025 Run focused backend unit tests in `backend/`
- [X] T026 Run `npm run build` in `backend/`
- [X] T027 Review diff for generated or unintended AGENTS changes and keep repo guidance durable

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup completion.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Depends on User Story 1 because the consumer shares the AMQP adapter.
- **User Story 3 (Phase 5)**: Depends on implemented configuration names.
- **Polish (Phase 6)**: Depends on all desired user stories.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T004 and T005 can run in parallel.
- T008 can run independently of T012/T013 once foundation exists.
- T020 and documentation edits can run after implementation config names settle.

## Implementation Strategy

### MVP First

1. Complete setup and foundation.
2. Deliver US1 so AMQP dispatch publishes messages.
3. Validate dispatch without changing ingestion/import/reprocess orchestration.

### Complete Queue Support

1. Add US2 consumer lifecycle so workers react to broker deliveries.
2. Add US3 docs and config examples.
3. Run focused tests and backend build.
