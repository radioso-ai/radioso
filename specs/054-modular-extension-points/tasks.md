# Tasks: Modular Extension Points

**Input**: Design documents from `/specs/054-modular-extension-points/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are required and must be written before implementation tasks. Frontend tests are not expected unless implementation adds user-visible frontend behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and validation.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm baseline context and prepare shared docs/configuration targets.

- [x] T001 Review current dependency assembly in `backend/src/app/server/dependencies.ts` and record any additional extraction constraints in `specs/054-modular-extension-points/plan.md`
- [x] T002 [P] Review existing runtime startup tests in `backend/tests/unit/runtime-startup.test.ts` and `backend/tests/integration/runtime-entrypoints.integration.test.ts`
- [x] T003 [P] Review existing documentation index in `docs/README.md` and root `readme.md` to decide where the extension model guide should be linked

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the focused composition and capability seams before user story work.

**Critical**: No user story work should begin until these seams exist.

### Tests First

- [x] T004 [P] Add failing unit tests for capability catalog and default allow policy in `backend/tests/unit/capability-policy.test.ts`
- [x] T005 [P] Add failing unit tests for application module duplicate detection and lifecycle behavior in `backend/tests/unit/application-modules.test.ts`

### Implementation

- [x] T006 Create capability name catalog and policy interfaces in `backend/src/modules/capabilities/capabilityPolicy.ts`
- [x] T007 Create default allow capability policy and test strict policy helper in `backend/src/modules/capabilities/capabilityPolicy.ts`
- [x] T008 Create application module types, registration context, and lifecycle coordinator in `backend/src/app/composition/applicationModule.ts`
- [x] T009 Export composition primitives from `backend/src/app/composition/index.ts`
- [x] T010 Add capability policy to `AppDependencies` in `backend/src/app/server/types.ts`

**Checkpoint**: Capability and application-module primitives are tested and ready for wiring.

---

## Phase 3: User Story 1 - Preserve The Default Product Through Explicit Composition (Priority: P1) MVP

**Goal**: Default application behavior is assembled through explicit composition while current workflows remain unchanged.

**Independent Test**: Backend default build and focused startup/composition tests pass without optional modules.

### Tests for User Story 1

- [x] T011 [P] [US1] Add failing default composition tests in `backend/tests/unit/default-composition.test.ts`
- [x] T012 [P] [US1] Add failing dependency builder regression tests for default capability policy and default module registration in `backend/tests/unit/runtime-startup.test.ts`

### Implementation for User Story 1

- [x] T013 [US1] Create default composition bundle in `backend/src/app/composition/defaultComposition.ts`
- [x] T014 [US1] Move built-in connector registration into the default composition path from `backend/src/app/server/dependencies.ts`
- [x] T015 [US1] Move telemetry, analytics, and incident sink bundle construction behind default composition helpers in `backend/src/app/composition/defaultComposition.ts`
- [x] T016 [US1] Move document storage and worker dispatch selection behind default composition helpers in `backend/src/app/composition/defaultComposition.ts`
- [x] T017 [US1] Move default retrieval stage/strategy construction helper into `backend/src/app/composition/defaultComposition.ts`
- [x] T018 [US1] Wire the default capability policy and default composition helpers into `backend/src/app/server/dependencies.ts`
- [x] T019 [US1] Verify `backend/src/app/server/dependencies.ts` remains an assembler and does not absorb new extension-specific policy logic

**Checkpoint**: User Story 1 is independently functional; default product composition works without optional modules.

---

## Phase 4: User Story 2 - Register Optional Capabilities Without Core Coupling (Priority: P1)

**Goal**: Optional test modules can register through supported extension points without changes to unrelated product services.

**Independent Test**: A representative optional module registers through composition and participates in a supported extension point.

### Tests for User Story 2

- [x] T020 [P] [US2] Add failing optional module registration tests in `backend/tests/unit/application-modules.test.ts`
- [x] T021 [P] [US2] Add failing optional connector contribution test in `backend/tests/unit/default-composition.test.ts`

### Implementation for User Story 2

- [x] T022 [US2] Extend `backend/src/app/composition/applicationModule.ts` with typed extension registration helpers for connectors, sinks, policies, storage, worker dispatch, and retrieval contributions
- [x] T023 [US2] Add optional module application support to `backend/src/app/composition/defaultComposition.ts`
- [x] T024 [US2] Update `backend/src/app/server/dependencies.ts` to accept optional module inputs for tests and future runtime composition without importing optional implementations
- [x] T025 [US2] Add duplicate identifier and failed initialization diagnostics through existing logging paths in `backend/src/app/composition/applicationModule.ts`

**Checkpoint**: Optional modules register through explicit composition and do not require scattered core imports.

---

## Phase 5: User Story 3 - Evaluate Capabilities Through A Neutral Policy Layer (Priority: P2)

**Goal**: Representative guarded actions consult the capability policy before mutation, while default behavior remains allowed.

**Independent Test**: Default policy allows existing action; strict test policy denies a representative action before mutation.

### Tests for User Story 3

- [x] T026 [P] [US3] Add failing document mutation capability-denial test in `backend/tests/unit/document-capability-policy.test.ts`
- [x] T027 [P] [US3] Add failing route or service regression test proving default policy preserves current document behavior in `backend/tests/unit/document-capability-policy.test.ts`

### Implementation for User Story 3

- [x] T028 [US3] Add representative document capability names to `backend/src/modules/capabilities/capabilityPolicy.ts`
- [x] T029 [US3] Inject capability policy into the chosen document mutation service dependency path in `backend/src/app/server/dependencies.ts`
- [x] T030 [US3] Apply the capability policy before the representative document mutation in the focused document service file under `backend/src/modules/documents/services/`
- [x] T031 [US3] Ensure capability denials use operational errors from `backend/src/shared/domain/errors.ts` and do not introduce assistant/chat response strings

**Checkpoint**: Capability policy can deny a representative action safely and default behavior remains unchanged.

---

## Phase 6: User Story 4 - Verify Standalone Default Builds In Continuous Integration (Priority: P2)

**Goal**: CI catches accidental optional-module dependency in the default build.

**Independent Test**: CI or local validation target builds the default composition without optional modules.

### Tests for User Story 4

- [x] T032 [P] [US4] Add or update a package script for default composition validation in `backend/package.json`
- [x] T033 [P] [US4] Add focused validation documentation to `specs/054-modular-extension-points/quickstart.md`

### Implementation for User Story 4

- [x] T034 [US4] Add CI validation for backend default composition in `.github/workflows/ci.yml` or the existing appropriate workflow file
- [x] T035 [US4] Verify the CI validation does not require optional modules, deployment-specific packages, or new required environment variables

**Checkpoint**: Default composition validation is automated.

---

## Phase 7: User Story 5 - Document The Extension Model For Maintainers (Priority: P3)

**Goal**: Maintainers can understand supported extension categories, ownership, defaults, and anti-goals.

**Independent Test**: Documentation names at least five extension categories with owner, registration path, default behavior, and anti-goals.

### Implementation for User Story 5

- [x] T036 [P] [US5] Create extension model guide in `docs/architecture-extension-points.md`
- [x] T037 [US5] Link the extension model guide from `docs/README.md`
- [x] T038 [US5] Confirm no root `readme.md` update is required because the common run flow did not change

**Checkpoint**: Documentation supports future extension work and review.

---

## Final Phase: Polish & Cross-Cutting Concerns

**Purpose**: Validate the full feature and clean up planning artifacts.

- [x] T039 Run focused backend tests for composition and capability policy from `backend/`
- [x] T040 Run backend build from `backend/`
- [x] T041 Confirm contract tests are not required because HTTP contract behavior did not change
- [x] T042 Re-run `rg` checks to confirm no deployment-specific optional-module imports were added to route handlers or product orchestration services
- [x] T043 Update `specs/054-modular-extension-points/quickstart.md` with final validation commands if they differ from the plan
- [x] T044 Review `specs/054-modular-extension-points/spec.md`, `plan.md`, and `tasks.md` for final implementation alignment

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational and is the MVP.
- **User Story 2 (Phase 4)**: Depends on Foundational; can proceed after US1 helper shapes are stable.
- **User Story 3 (Phase 5)**: Depends on Foundational and the default capability dependency from US1.
- **User Story 4 (Phase 6)**: Depends on US1 default composition.
- **User Story 5 (Phase 7)**: Can proceed after core implementation choices are known.
- **Polish**: Depends on selected user stories.

### User Story Dependencies

- **US1**: Required first for default composition.
- **US2**: Can start after foundational primitives, but final wiring should align with US1 default composition.
- **US3**: Requires capability policy from foundational work and dependency wiring from US1.
- **US4**: Requires default composition scripts/tests from US1.
- **US5**: Best completed after US1-US4 implementation details are stable.

### Parallel Opportunities

- T002 and T003 can run in parallel.
- T004 and T005 can run in parallel.
- T011 and T012 can run in parallel.
- T020 and T021 can run in parallel.
- T026 and T027 can run in parallel.
- Documentation task T036 can start once extension categories are stable.

---

## Parallel Example: User Story 1

```text
Task: "Add failing default composition tests in backend/tests/unit/default-composition.test.ts"
Task: "Add failing dependency builder regression tests for default capability policy and default module registration in backend/tests/unit/runtime-startup.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases.
2. Complete User Story 1 so default composition is explicit and verified.
3. Stop and validate backend build plus focused tests.

### Incremental Delivery

1. Add optional module registration after default composition is stable.
2. Add representative capability policy enforcement.
3. Add CI validation for standalone default builds.
4. Document the extension model.

### Review Strategy

Review each phase for boundary preservation. Reject changes that put optional-module imports, adapter-specific payload logic, or capability policy decisions into unrelated route handlers, frontend components, or orchestration services.
