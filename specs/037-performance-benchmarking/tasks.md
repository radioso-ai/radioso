# Tasks: Performance Benchmarking

**Input**: Design documents from `/specs/037-performance-benchmarking/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend-adjacent tooling tests are REQUIRED. Write failing tests first for profile validation, budget evaluation, baseline comparison, and workload orchestration helpers before implementing the harness.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. `US1`, `US2`)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the benchmark tooling structure and repo-facing documentation seams.

- [x] T001 Create benchmark tooling directories under `scripts/performance/`, `scripts/performance/lib/`, `scripts/performance/lib/collectors/`, and `tests/performance/`
- [x] T002 [P] Add benchmark documentation shell in `docs/performance-benchmarking.md`
- [x] T003 [P] Add benchmark task breakdown and execution notes in `specs/037-performance-benchmarking/tasks.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core benchmark contracts and utilities that block all user stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 [P] Add failing profile validation tests in `tests/performance/profile-validation.test.mjs`
- [x] T005 [P] Add failing budget and comparison tests in `tests/performance/budget-evaluation.test.mjs` and `tests/performance/baseline-comparison.test.mjs`
- [x] T006 [P] Implement benchmark profile definitions and validation in `scripts/performance/lib/profiles.mjs`
- [x] T007 [P] Implement result, budget, and baseline comparison logic in `scripts/performance/lib/budgets.mjs`
- [x] T008 Implement shared CLI parsing, artifact paths, and reporting helpers in `scripts/performance/lib/reporting.mjs`
- [x] T009 Implement authenticated benchmark HTTP client and workspace bootstrap helpers in `scripts/performance/lib/session-client.mjs`

**Checkpoint**: Foundation ready. User story implementation can now proceed.

---

## Phase 3: User Story 1 - Run Repeatable Benchmark Profiles (Priority: P1) 🎯 MVP

**Goal**: Engineers can run named benchmark profiles and receive bounded benchmark results.

**Independent Test**: Run `node scripts/performance/runProfile.mjs --list` and at least one safe profile against a prepared environment to produce a bounded JSON artifact and terminal report.

### Tests for User Story 1

- [x] T010 [P] [US1] Add failing runner and reporting tests in `tests/performance/run-profile.test.mjs`

### Implementation for User Story 1

- [x] T011 [P] [US1] Implement generic workload runner and metric summarization in `scripts/performance/lib/workloads.mjs`
- [x] T012 [P] [US1] Implement profile execution orchestration in `scripts/performance/lib/runner.mjs`
- [x] T013 [US1] Implement benchmark CLI entrypoint in `scripts/performance/runProfile.mjs`
- [x] T014 [US1] Document safe local profile usage and CLI arguments in `docs/performance-benchmarking.md`

**Checkpoint**: User Story 1 is independently functional and can run safe benchmark profiles.

---

## Phase 4: User Story 2 - Detect Regressions Against A Baseline (Priority: P1)

**Goal**: Engineers can compare a benchmark run against a saved baseline and get per-metric verdicts.

**Independent Test**: Compare two benchmark result artifacts and verify regressions, improvements, and within-tolerance changes are reported correctly.

### Tests for User Story 2

- [x] T015 [P] [US2] Extend comparison coverage for saved artifact inputs in `tests/performance/baseline-comparison.test.mjs`

### Implementation for User Story 2

- [x] T016 [US2] Implement baseline comparison CLI in `scripts/performance/compareBaseline.mjs`
- [x] T017 [US2] Add baseline workflow documentation in `docs/performance-benchmarking.md`

**Checkpoint**: User Stories 1 and 2 work independently.

---

## Phase 5: User Story 3 - Test The Real Failure Boundaries (Priority: P2)

**Goal**: Engineers can run stress and soak profiles with backlog-aware metrics and explicit safety gating.

**Independent Test**: Run a guarded stress or soak profile in an allowed environment class and verify saturation or backlog signals are captured or clearly marked inconclusive when prerequisites are missing.

### Tests for User Story 3

- [x] T018 [P] [US3] Add failing collector and safety-tier tests in `tests/performance/queue-collector.test.mjs`

### Implementation for User Story 3

- [x] T019 [P] [US3] Implement queue snapshot collector and external-command integration in `scripts/performance/lib/collectors/queue-snapshot.mjs`
- [x] T020 [US3] Wire backlog-aware ingestion, mixed, stress, and soak profiles in `scripts/performance/lib/runner.mjs` and `scripts/performance/lib/profiles.mjs`
- [x] T021 [US3] Document guarded and restricted profile behavior in `docs/performance-benchmarking.md`

**Checkpoint**: Stress and soak profiles expose failure boundaries with explicit safety rules.

---

## Phase 6: User Story 4 - Use The Same Benchmark Definitions In Local, CI, And Pre-Release Checks (Priority: P3)

**Goal**: The repo contains a shared benchmark source of truth that works across environment classes.

**Independent Test**: Validate that the same profile manifests and budget rules can be used with different environment classes without changing source files.

### Tests for User Story 4

- [x] T022 [P] [US4] Add environment-class validation coverage in `tests/performance/profile-validation.test.mjs`

### Implementation for User Story 4

- [x] T023 [US4] Add environment-class handling and artifact metadata in `scripts/performance/lib/profiles.mjs`, `scripts/performance/lib/reporting.mjs`, and `scripts/performance/lib/runner.mjs`
- [x] T024 [US4] Add quickstart-aligned usage examples for local, CI, and pre-release execution in `docs/performance-benchmarking.md`

**Checkpoint**: All user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, task closure, and documentation parity.

- [x] T025 [P] Run tooling test suite with `node --test tests/performance/*.test.mjs`
- [x] T026 [P] Run benchmark CLI smoke checks with `node scripts/performance/runProfile.mjs --list` and `node scripts/performance/compareBaseline.mjs --help`
- [x] T027 Update completed checkboxes and final notes in `specs/037-performance-benchmarking/tasks.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup; blocks all user stories.
- **User Story phases (Phase 3 onward)**: Depend on Foundational completion.
- **Polish (Phase 7)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1**: Starts after Foundational; no dependency on other stories.
- **US2**: Starts after Foundational and builds on the result artifacts from US1.
- **US3**: Starts after Foundational and extends US1 with backlog-aware collectors and guarded profiles.
- **US4**: Starts after Foundational and depends on the profile/budget foundations from US1 and US2.

### Within Each User Story

- Tests must fail before implementation.
- Shared contracts and profile definitions must land before CLI wiring.
- Reporting and artifact semantics must stay consistent between runner and comparer.

## Parallel Opportunities

- `T004` and `T005` can run in parallel.
- `T006`, `T007`, and `T009` can run in parallel after tests are in place.
- `T011` and `T012` can run in parallel before CLI integration.
- `T019` can run in parallel with documentation tasks.

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Setup and Foundational phases.
2. Land US1 with safe profile execution and bounded artifacts.
3. Validate the runner with list and local-smoke usage.

### Incremental Delivery

1. Add baseline comparison (US2).
2. Add guarded backlog-aware stress and soak behavior (US3).
3. Finish environment-class portability and documentation parity (US4).

### Notes

- Keep benchmark logic out of production HTTP routes unless black-box collection proves insufficient.
- Keep artifacts under `.context/performance-runs/` rather than version-controlled docs.
- Prefer bounded, trustworthy results over high-volume raw logs.
