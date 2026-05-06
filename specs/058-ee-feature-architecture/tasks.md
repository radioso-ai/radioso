# Tasks: Enterprise Feature Architecture Boundaries

**Input**: Design documents from `/specs/058-ee-feature-architecture/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend and script tests are required before implementation. Frontend user-visible behavior is unchanged; route generation tests cover non-visual logic.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup

**Purpose**: Establish feature artifacts and test targets.

- [x] T001 Create Speckit plan, research, data model, quickstart, and tasks artifacts in `specs/058-ee-feature-architecture/`
- [x] T002 Add package scripts for architecture boundary validation in root `package.json` or nearest suitable package manifest

---

## Phase 2: Foundational

**Purpose**: Add shared manifest and validation primitives used by the stories.

- [x] T003 [P] Add feature manifest contract and validation tests in `ee/packages/backend-module/src/featureManifest.test.ts`
- [x] T004 Add feature manifest contract and validation helpers in `ee/packages/backend-module/src/featureManifest.ts`
- [x] T005 [P] Add architecture boundary validation tests in `backend/tests/unit/architecture-boundaries.test.ts`
- [x] T006 Add architecture boundary validation script in `scripts/validate-architecture-boundaries.mjs`

---

## Phase 3: User Story 1 - Understand Enterprise Feature Ownership (Priority: P1)

**Goal**: Enterprise backend registration is decomposed into focused feature modules without behavior changes.

**Independent Test**: Enterprise backend module tests confirm route mounts, migrators, hooks, policies, integrations, and lifecycle behavior remain registered through feature modules.

### Tests for User Story 1

- [x] T007 [P] [US1] Add Enterprise feature module aggregation tests in `ee/packages/backend-module/src/index.test.ts`

### Implementation for User Story 1

- [x] T008 [P] [US1] Add usage limits application module in `ee/packages/backend-module/src/usageLimits/applicationModule.ts`
- [x] T009 [P] [US1] Add Enterprise auth application module in `ee/packages/backend-module/src/mail/applicationModule.ts`
- [x] T010 [P] [US1] Add human contact application module in `ee/packages/backend-module/src/humanContact/applicationModule.ts`
- [x] T011 [P] [US1] Add website crawler application module in `ee/packages/backend-module/src/websiteCrawler/applicationModule.ts`
- [x] T012 [P] [US1] Add website embed application module in `ee/packages/backend-module/src/websiteEmbedApplicationModule.ts`
- [x] T013 [US1] Refactor Enterprise backend index aggregation in `ee/packages/backend-module/src/index.ts`

---

## Phase 4: User Story 2 - Keep Architecture Boundaries Enforced (Priority: P1)

**Goal**: Automated validation prevents OSS imports from EE and catches representative private cross-module backend imports.

**Independent Test**: Boundary validation tests exercise forbidden OSS-to-EE imports, allowed public contract imports, and private cross-module imports.

### Tests for User Story 2

- [x] T014 [P] [US2] Extend architecture boundary tests for OSS-to-EE and cross-module private imports in `backend/tests/unit/architecture-boundaries.test.ts`

### Implementation for User Story 2

- [x] T015 [US2] Implement import scanning and rule evaluation in `scripts/validate-architecture-boundaries.mjs`
- [x] T016 [US2] Add documented temporary exception support in `scripts/validate-architecture-boundaries.mjs`

---

## Phase 5: User Story 3 - Depend On Public Contracts Instead Of Internals (Priority: P2)

**Goal**: Representative cross-boundary dependencies use discoverable public contract surfaces.

**Independent Test**: Boundary validation allows public contract imports and affected packages build against the contracts.

### Tests for User Story 3

- [x] T017 [P] [US3] Add tests that allowed contract imports pass boundary validation in `backend/tests/unit/architecture-boundaries.test.ts`

### Implementation for User Story 3

- [x] T018 [P] [US3] Add chat public contract barrel in `backend/src/modules/chat/contracts/index.ts`
- [x] T019 [P] [US3] Add documents public contract barrel in `backend/src/modules/documents/contracts/index.ts`
- [x] T020 [P] [US3] Add settings public contract barrel in `backend/src/modules/settings/contracts/index.ts`
- [x] T021 [P] [US3] Add app composition public contract barrel in `backend/src/app/contracts/index.ts`
- [x] T022 [US3] Keep the standalone Enterprise runtime contract mirror in `ee/packages/backend-module/src/radiosoModuleTypes.ts` package-local while adding public OSS contract barrels for future in-repo consumers

---

## Phase 6: User Story 4 - Declare Feature-Owned Wiring In Manifests (Priority: P2)

**Goal**: Existing Enterprise features expose lightweight manifests and manifest validation catches ownership errors.

**Independent Test**: Manifest validation tests catch duplicate IDs, duplicate routes, malformed route metadata, and missing docs.

### Tests for User Story 4

- [x] T023 [P] [US4] Extend manifest validation tests in `ee/packages/backend-module/src/featureManifest.test.ts`

### Implementation for User Story 4

- [x] T024 [P] [US4] Add backend feature manifests beside EE backend feature modules
- [x] T025 [P] [US4] Add auth frontend feature manifest in `ee/packages/auth-frontend/src/featureManifest.ts`
- [x] T026 [P] [US4] Add embed widget frontend feature manifest in `ee/packages/embed-widget/src/featureManifest.ts`
- [x] T027 [US4] Add aggregate Enterprise feature manifest registry in `ee/packages/backend-module/src/features/index.ts`

---

## Phase 7: User Story 5 - Generate Enterprise Frontend Route Stubs From Ownership Metadata (Priority: P3)

**Goal**: Enterprise frontend route stubs are generated from manifest route metadata.

**Independent Test**: Route generation tests confirm generated stubs match current routes and invalid metadata fails before writing.

### Tests for User Story 5

- [x] T028 [P] [US5] Add route synchronization tests in `backend/tests/unit/ee-route-sync.test.ts`

### Implementation for User Story 5

- [x] T029 [US5] Refactor `scripts/sync-ee-frontend-routes.mjs` to derive generated files from feature manifests
- [x] T030 [US5] Preserve enable and disable behavior for generated frontend route files

---

## Phase 8: Polish & Cross-Cutting

**Purpose**: Documentation, validation, and cleanup.

- [x] T031 [P] Update Enterprise architecture documentation in `ee/readme.md`
- [x] T032 [P] Update local run-flow documentation in `readme.md`
- [x] T033 Run `node scripts/validate-architecture-boundaries.mjs`
- [x] T034 Run `cd backend && npm test -- --run architecture-boundaries application-modules default-composition`
- [x] T035 Run `cd ee && npm test`
- [x] T036 Run `cd ee && npm run build`
- [x] T037 Run `cd backend && npm run build`

## Dependencies & Execution Order

- Phase 1 and Phase 2 are required before user-story implementation.
- US1 should land before US4 because manifests refer to stable feature modules.
- US2 and US3 can proceed after foundational validation exists.
- US5 depends on US4 route metadata.
- Polish depends on all desired user stories.

## Implementation Strategy

Deliver US1 and US2 as the MVP: feature ownership plus enforceable boundaries. Then add public contracts, manifests, and route generation. Validate each slice with focused tests before moving to the next.
