# Tasks: Terminal Bootstrap Installer

**Input**: Design documents from `/specs/025-terminal-bootstrap/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Bootstrap modules MUST follow TDD. Write failing `node:test` coverage before implementation for each user story slice that changes behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

**Architecture**: Tasks preserve the module ownership in `plan.md`: `run-dev.sh` stays a thin wrapper, `scripts/bootstrap/` owns terminal bootstrap behavior, `backend/src/app/config/env.ts` remains runtime-only validation, and `infra/docker-compose*.yml` remain startup topology sources of truth.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. [US1], [US2], [US3], [US4])
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the bootstrap workspace and replace placeholder startup entry assumptions

- [x] T001 Create bootstrap source and test directories in `scripts/bootstrap/`, `scripts/bootstrap/support/`, and `tests/bootstrap/`
- [x] T002 Create the root bootstrap entry scaffold in `scripts/bootstrap/index.mjs`
- [x] T003 [P] Create the root support scaffolds in `scripts/bootstrap/preflight.mjs`, `scripts/bootstrap/prompt-flow.mjs`, `scripts/bootstrap/env-file.mjs`, `scripts/bootstrap/terminal-theme.mjs`, `scripts/bootstrap/compose-runner.mjs`, `scripts/bootstrap/support/env-contract.mjs`, `scripts/bootstrap/support/ansi-capabilities.mjs`, and `scripts/bootstrap/support/process-utils.mjs`
- [x] T004 [P] Create the bootstrap test harness scaffold in `tests/bootstrap/preflight.test.mjs`, `tests/bootstrap/prompt-flow.test.mjs`, `tests/bootstrap/env-file.test.mjs`, `tests/bootstrap/terminal-theme.test.mjs`, and `tests/bootstrap/compose-runner.test.mjs`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared bootstrap seams that all user stories depend on

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Update `run-dev.sh` to act only as a thin wrapper around `scripts/bootstrap/index.mjs`
- [x] T006 [P] Implement shell/process helpers in `scripts/bootstrap/support/process-utils.mjs` for command execution, port checks, and deterministic test stubbing
- [x] T007 [P] Implement terminal capability detection in `scripts/bootstrap/support/ansi-capabilities.mjs`
- [x] T008 [P] Implement the canonical bootstrap env contract mapping in `scripts/bootstrap/support/env-contract.mjs` using `backend/.env.example`
- [x] T009 [P] Update `backend/.env.example` to remove placeholder secrets that the installer will generate and to keep installer-facing defaults/comments in sync

**Checkpoint**: Foundation ready. User story work can begin.

---

## Phase 3: User Story 1 - Start Radioso From One Default Command (Priority: P1) 🎯 MVP

**Goal**: One repository-root command handles both first-run setup and routine local startup.

**Independent Test**: Run `./run-dev.sh` from a fresh repo state and a configured repo state; verify it either gathers missing setup inputs or skips directly to startup and reports ready local URLs.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T010 [P] [US1] Add repeat-start and first-run bootstrap orchestration tests in `tests/bootstrap/compose-runner.test.mjs`
- [x] T011 [P] [US1] Add session mode and startup flow tests in `tests/bootstrap/preflight.test.mjs`

### Implementation for User Story 1

- [x] T012 [P] [US1] Implement bootstrap session state detection in `scripts/bootstrap/preflight.mjs`
- [x] T013 [P] [US1] Implement compose startup and readiness summary flow in `scripts/bootstrap/compose-runner.mjs`
- [x] T014 [US1] Implement end-to-end default start orchestration in `scripts/bootstrap/index.mjs`
- [x] T015 [US1] Update `specs/025-terminal-bootstrap/quickstart.md` with the final default command wording and verification notes

**Checkpoint**: User Story 1 should support first-run and repeat local startup through one command.

---

## Phase 4: User Story 2 - Configure Only What Matters (Priority: P2)

**Goal**: The default command asks only for required values, validates them, generates safe defaults, and preserves existing valid config.

**Independent Test**: Run the command with missing, partial, and valid `backend/.env` states; confirm only required questions appear, invalid answers are rejected, generated values are written safely, and valid existing values are reused.

### Tests for User Story 2

- [x] T016 [P] [US2] Add prompt sequencing and conditional-question tests in `tests/bootstrap/prompt-flow.test.mjs`
- [x] T017 [P] [US2] Add env merge, preserve, and safe-write tests in `tests/bootstrap/env-file.test.mjs`

### Implementation for User Story 2

- [x] T018 [P] [US2] Implement conditional question planning and masked secret input handling in `scripts/bootstrap/prompt-flow.mjs`
- [x] T019 [P] [US2] Implement `backend/.env` parsing, merge, validation, and atomic write behavior in `scripts/bootstrap/env-file.mjs`
- [x] T020 [US2] Wire prompt flow, generated defaults, and env persistence into `scripts/bootstrap/index.mjs`

**Checkpoint**: User Story 2 should collect only relevant config, reject bad input, and preserve valid local env values on repeat runs.

---

## Phase 5: User Story 3 - Recover From Setup Problems Quickly (Priority: P3)

**Goal**: Dependency, port, and readiness failures stop early and explain the exact recovery path.

**Independent Test**: Simulate missing Docker, stopped Docker daemon, missing `docker compose`, blocked ports, and unhealthy services; confirm the command exits with clear blocker-specific recovery guidance.

### Tests for User Story 3

- [x] T021 [P] [US3] Add dependency and blocked-port failure tests in `tests/bootstrap/preflight.test.mjs`
- [x] T022 [P] [US3] Add readiness failure reporting tests in `tests/bootstrap/compose-runner.test.mjs`

### Implementation for User Story 3

- [x] T023 [P] [US3] Implement dependency, daemon, and port preflight checks in `scripts/bootstrap/preflight.mjs`
- [x] T024 [P] [US3] Implement readiness failure summaries and recovery hints in `scripts/bootstrap/compose-runner.mjs`
- [x] T025 [US3] Integrate blocker handling and actionable terminal summaries in `scripts/bootstrap/index.mjs`

**Checkpoint**: User Story 3 should fail early and explain exactly how to recover.

---

## Phase 6: User Story 4 - Enjoy A Clear Branded Terminal Experience (Priority: P3)

**Goal**: The terminal flow is visually polished with ANSI theming, a pixel-style yellow sun and clouds, and graceful fallback behavior.

**Independent Test**: Run the command in ANSI-capable and reduced-style terminals; confirm the header art renders when supported, state messaging is visually distinct, and the flow remains readable without color.

### Tests for User Story 4

- [x] T026 [P] [US4] Add ANSI-capable and fallback rendering tests in `tests/bootstrap/terminal-theme.test.mjs`
- [x] T027 [P] [US4] Add bootstrap header and message-style integration assertions in `tests/bootstrap/prompt-flow.test.mjs`

### Implementation for User Story 4

- [x] T028 [P] [US4] Implement theme palette, message styles, and sun/cloud pixel header in `scripts/bootstrap/terminal-theme.mjs`
- [x] T029 [P] [US4] Implement ANSI fallback selection and width-aware header rendering in `scripts/bootstrap/support/ansi-capabilities.mjs`
- [x] T030 [US4] Integrate themed rendering into `scripts/bootstrap/index.mjs` and `scripts/bootstrap/prompt-flow.mjs`

**Checkpoint**: User Story 4 should render a branded terminal experience without sacrificing usability.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final consistency, documentation, and validation across all stories

- [x] T031 [P] Add default-start documentation updates in `AGENTS.md` and `frontend/README.md`
- [x] T032 Run the full bootstrap test suite via `node --test tests/bootstrap/*.test.mjs` and record results in `specs/025-terminal-bootstrap/quickstart.md`
- [x] T033 [P] Review and tighten module boundaries in `scripts/bootstrap/index.mjs` and `run-dev.sh` so orchestration and wrapper responsibilities remain small

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and shares orchestration touchpoints with US1
- **User Story 3 (Phase 5)**: Depends on Foundational completion and can begin after the preflight/compose seams from US1 exist
- **User Story 4 (Phase 6)**: Depends on Foundational completion and can be integrated after the main bootstrap flow exists
- **Polish (Phase 7)**: Depends on all selected user stories being complete

### User Story Dependencies

- **US1**: MVP; no dependency on later stories
- **US2**: Builds on the same default command path as US1 but remains independently testable through env handling
- **US3**: Builds on shared preflight/startup seams and remains independently testable through failure scenarios
- **US4**: Builds on the same command path but remains independently testable through rendering/fallback checks

### Within Each User Story

- Write tests first and verify they fail
- Implement focused modules before expanding orchestration
- Keep `run-dev.sh` as a wrapper only
- Keep compose files as startup topology owners
- Complete the story checkpoint before moving on

### Parallel Opportunities

- T003 and T004 can run in parallel after T002
- T006, T007, T008, and T009 can run in parallel in Foundational phase
- Per-story test tasks marked `[P]` can run in parallel
- Module tasks marked `[P]` within US2, US3, and US4 can run in parallel before their orchestration task

---

## Parallel Example: User Story 2

```bash
Task: "Add prompt sequencing and conditional-question tests in tests/bootstrap/prompt-flow.test.mjs"
Task: "Add env merge, preserve, and safe-write tests in tests/bootstrap/env-file.test.mjs"

Task: "Implement conditional question planning and masked secret input handling in scripts/bootstrap/prompt-flow.mjs"
Task: "Implement backend/.env parsing, merge, validation, and atomic write behavior in scripts/bootstrap/env-file.mjs"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. Validate the default command on fresh and repeat startup states

### Incremental Delivery

1. Land the default command path and startup orchestration (US1)
2. Add smart configuration prompts and safe env persistence (US2)
3. Add explicit recovery behavior for failures (US3)
4. Add the branded ANSI presentation and fallback logic (US4)
5. Finish with docs and full-suite validation

### Parallel Team Strategy

1. Complete Setup and Foundational work together
2. After US1 establishes the main bootstrap flow:
   - Developer A: US2 env handling
   - Developer B: US3 recovery/reporting
   - Developer C: US4 terminal presentation

---

## Notes

- All tasks follow the required checklist format with IDs and file paths.
- Backend HTTP/OpenAPI tasks are intentionally absent because this feature does not change product routes.
- `AGENTS.md` was updated during planning by the agent-context script and should be reviewed during polish rather than treated as a feature requirement by itself.
