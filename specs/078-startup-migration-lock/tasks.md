# Tasks: Startup Migration Lock Reliability

**Input**: Design documents from `/specs/078-startup-migration-lock/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend tests are required and must be written and observed failing before implementation.

**Organization**: Tasks are grouped by user story so each behavior can be verified independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files or only reads context
- **[Story]**: User story label from `spec.md`
- Every task includes exact file paths

## Phase 1: Setup

**Purpose**: Confirm approved scope and supporting artifacts.

- [x] T001 Mark approved spec status in `specs/078-startup-migration-lock/spec.md`
- [x] T002 Create implementation plan in `specs/078-startup-migration-lock/plan.md`
- [x] T003 [P] Create research notes in `specs/078-startup-migration-lock/research.md`
- [x] T004 [P] Create data model notes in `specs/078-startup-migration-lock/data-model.md`
- [x] T005 [P] Create validation quickstart in `specs/078-startup-migration-lock/quickstart.md`

---

## Phase 2: Foundational

**Purpose**: Add backend TDD coverage before changing migration behavior.

- [x] T006 [P] Add failing migration sequencing tests for existing-table no-DDL and fresh-table initialization in `backend/tests/unit/run-migrations.test.ts`
- [x] T007 [P] Add failing migration timeout/config tests in `backend/tests/unit/database-config.test.ts`
- [x] T008 [P] Add failing API startup logging/error propagation test in `backend/tests/unit/runtime-startup.test.ts`
- [x] T009 Run focused failing tests with `cd backend && pnpm test -- tests/unit/run-migrations.test.ts tests/unit/database-config.test.ts tests/unit/runtime-startup.test.ts`

**Checkpoint**: Tests fail for the missing migration reliability behavior.

---

## Phase 3: User Story 1 - Backend Starts Cleanly When Migrations Are Current (Priority: P1) MVP

**Goal**: Steady-state backend startup avoids metadata-table DDL when migrations are current.

**Independent Test**: Existing `schema_migrations` table with all migration filenames results in no table-creation DDL and normal startup completion.

### Implementation

- [x] T010 [US1] Implement SELECT-first metadata table detection in `backend/src/db/runMigrations.ts`
- [x] T011 [US1] Preserve fresh-database metadata table creation and migration application in `backend/src/db/runMigrations.ts`
- [x] T012 [US1] Verify US1 tests pass with `cd backend && pnpm test -- tests/unit/run-migrations.test.ts`

---

## Phase 4: User Story 2 - Blocked Startup Migration Fails Fast And Loudly (Priority: P1)

**Goal**: Blocked migration metadata checks produce bounded, structured startup failures while migration SQL bodies can still complete long index builds or backfills.

**Independent Test**: Migration startup uses a migration timeout budget and logs a migration startup failure before throwing.

### Implementation

- [x] T013 [US2] Add generic PostgreSQL lock timeout pool option in `backend/src/shared/infra/database.ts`
- [x] T014 [US2] Add migration timeout environment parsing and defaults in `backend/src/app/config/env.ts`
- [x] T015 [US2] Document migration timeout configuration in `.env.example`
- [x] T016 [US2] Apply migration lock and statement timeout budgets in `backend/src/db/runMigrations.ts`
- [x] T017 [US2] Add structured API startup migration begin/failure logging in `backend/src/runtime/startApiRuntime.ts`
- [x] T018 [US2] Verify US2 tests pass with `cd backend && pnpm test -- tests/unit/database-config.test.ts tests/unit/runtime-startup.test.ts tests/unit/run-migrations.test.ts`

---

## Phase 5: User Story 3 - Operators Can Diagnose And Recover Migration Lock Incidents (Priority: P2)

**Goal**: Operators can understand migration ownership, expected failure signals, diagnostics, and recovery.

**Independent Test**: Operator docs explain backend migration ownership, fast-fail logs, lock diagnostic query pattern, and recovery without requiring issue #613.

### Implementation

- [x] T019 [US3] Update deployment runtime separation and rollout guidance in `docs-portal/content/operators/deployment.mdx`
- [x] T020 [US3] Update self-hosting upgrade and incident guidance in `docs-portal/content/operators/self-hosting-operations.mdx`
- [x] T021 [US3] Verify docs mention migration timeout signal, blocking-session diagnostics, and future pre-deploy migration job scope

---

## Phase 6: Polish & Validation

**Purpose**: Final checks and review readiness.

- [x] T022 Run focused validation from `specs/078-startup-migration-lock/quickstart.md`
- [x] T023 Run backend build with `cd backend && pnpm run build`
- [x] T024 [P] Confirm message-queue impact remains unaffected in `specs/078-startup-migration-lock/plan.md`
- [x] T025 [P] Check git diff for secrets, generated artifacts, and out-of-scope changes
- [x] T026 Request senior engineer review and address findings
- [x] T027 Request engineering manager review and address in-scope feedback

## Dependencies & Execution Order

- Setup tasks are complete before implementation.
- Foundational tests T006-T009 must complete before code changes.
- US1 and US2 both depend on the failing tests from Phase 2.
- US3 depends on reading `docs/document-writer-prompt.md`, already completed before documentation edits.
- Polish validation depends on US1, US2, and US3 completion.

## Parallel Opportunities

- T006, T007, and T008 can be authored independently before T009.
- T019 and T020 can be edited independently after implementation behavior is clear.
- T024 and T025 can run in parallel during final validation.

## Implementation Strategy

1. Write failing tests first.
2. Implement SELECT-first migration metadata detection.
3. Add migration timeout configuration, migration connection options, and runtime logging.
4. Update operator docs.
5. Run focused tests, backend build, review passes, and final diff inspection.
