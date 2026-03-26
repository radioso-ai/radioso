# Tasks: Generic Retrieval Signal Policies

**Input**: Design documents from `/specs/028-signal-policy-engine/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED. New or updated backend tests must fail before implementation changes land. Frontend validation follows the feature quickstart and existing settings UI flow.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the active feature artifacts and current retrieval-settings seams before implementation.

- [ ] T001 Verify the active feature artifacts in `/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/` and the target backend/frontend files in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/settings/domain/retrievalSettings.ts`, `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/db/repositories/retrievalSettingsRepository.ts`, `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/app/http/routes/settingsRoutes.ts`, `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/app/http/openapi/document.ts`, `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/attributeMatchScoringService.ts`, and `/Users/dm/conductor/workspaces/radioso/buffalo/frontend/components/dashboard/settings-view.tsx`
- [ ] T002 Review retrieval settings dependency wiring and test helpers in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/app/server/dependencies.ts`, `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/support/testApp.ts`, and `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/support/fakes.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the signal-policy architecture seam and persistence migration before user-story wiring.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Add failing unit coverage for retrieval signal policy defaults, validation, and legacy translation in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [ ] T004 [P] Add failing contract coverage for `signalPolicies` replacing `attributeControls` in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/contract/settings.contract.test.ts`
- [ ] T005 [P] Add failing integration coverage for legacy workspace compatibility and retrieval settings round-tripping in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/integration/document-settings.integration.test.ts`
- [ ] T006 [P] Introduce retrieval signal policy types, defaults, validation, and legacy translation helpers in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/settings/domain/retrievalSettings.ts`
- [ ] T007 [P] Add the additive `signal_policies` migration and backfill logic in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/db/migrations/010_signal_policies.sql`
- [ ] T008 [P] Update retrieval settings repository persistence and compatibility reads in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/db/repositories/retrievalSettingsRepository.ts`
- [ ] T009 Update retrieval settings service normalization to use the new signal-policy model in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/settings/services/retrievalSettingsService.ts`

**Checkpoint**: Signal policies exist as a validated backend seam with migration and compatibility coverage in place.

---

## Phase 3: User Story 1 - Configure Retrieval Signals Without Code Changes (Priority: P1) 🎯 MVP

**Goal**: Replace the public retrieval settings contract and UI with generic signal policies, removing the legacy four-family controls from the admin surface.

**Independent Test**: Load retrieval settings in the UI, confirm the legacy family labels are gone, change one or more signal policies, save, reload, and confirm the same policies return from the backend as `signalPolicies`.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T010 [P] [US1] Extend contract assertions for retrieval settings `GET`/`PUT` to require `signalPolicies` and reject legacy payload assumptions in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/contract/settings.contract.test.ts`
- [ ] T011 [P] [US1] Add integration coverage for saving and reloading signal policies across legacy and new workspaces in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/integration/document-settings.integration.test.ts`

### Implementation for User Story 1

- [ ] T012 [US1] Update retrieval settings request validation and route handling to use `signalPolicies` in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/app/http/routes/settingsRoutes.ts`
- [ ] T013 [US1] Update code-first retrieval settings schemas and endpoints in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/app/http/openapi/document.ts`
- [ ] T014 [US1] Update frontend API types and retrieval settings client methods in `/Users/dm/conductor/workspaces/radioso/buffalo/frontend/lib/api.ts`
- [ ] T015 [US1] Replace the legacy retrieval attribute-family editor with a generic signal-policy editor in `/Users/dm/conductor/workspaces/radioso/buffalo/frontend/components/dashboard/settings-view.tsx`
- [ ] T016 [US1] Regenerate generated OpenAPI outputs in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/buffalo/backend/openapi.json`

**Checkpoint**: User Story 1 is complete when the retrieval settings API and UI expose only generic signal policies.

---

## Phase 4: User Story 2 - Apply Generic Signal Policies During Retrieval (Priority: P2)

**Goal**: Move retrieval scoring and query preparation onto a generic signal-policy path driven by typed evaluators rather than legacy family-specific branches.

**Independent Test**: Run covered retrieval tests for supported date, amount, and location literals and confirm the pipeline still applies boosts or filters via the new signal-policy/evaluator model.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T017 [P] [US2] Add failing unit coverage for generic signal constraint parsing and query stripping in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/unit/hybrid-query-constraints.test.ts`
- [ ] T018 [P] [US2] Add failing unit coverage for evaluator-driven scoring behavior and fallback handling in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/unit/edge-cases.test.ts`
- [ ] T019 [P] [US2] Add failing pipeline coverage for signal-policy-driven retrieval stage behavior in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/unit/retrieval-pipeline-stages.test.ts`

### Implementation for User Story 2

- [ ] T020 [P] [US2] Update retrieval-domain constraint types to use generic signal keys and value types in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/domain/structuredAttributes.ts` and `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [ ] T021 [P] [US2] Refactor query parsing and query-preparation helpers to emit and strip generic signal constraints in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/queryConstraintParser.ts`, `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/queryInterpretationStage.ts`, and `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- [ ] T022 [P] [US2] Introduce typed signal evaluators and replace family-specific matching in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/signalEvaluatorRegistry.ts` and `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/attributeMatchScoringService.ts`
- [ ] T023 [US2] Update candidate preparation and retrieval diagnostics wiring to use signal policies in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/retrieval/services/candidatePreparationStage.ts` and related retrieval diagnostics consumers

**Checkpoint**: User Story 2 is complete when retrieval applies policies through the new generic evaluation path and covered retrieval behavior remains intact.

---

## Phase 5: User Story 3 - Migrate Existing Workspaces Safely (Priority: P3)

**Goal**: Ensure old workspaces load and save through the new model without manual repair, and keep diagnostics clear when legacy data is translated.

**Independent Test**: Seed or simulate a legacy retrieval-settings row, load settings through the service and HTTP contract, save the new settings, and confirm the workspace now round-trips through the new signal-policy representation.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T024 [P] [US3] Add unit coverage for repository/service compatibility paths and duplicate-policy handling in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [ ] T025 [P] [US3] Add integration coverage for migrated persistence after save in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/integration/document-settings.integration.test.ts`
- [ ] T026 [P] [US3] Add benchmark/integration assertions ensuring retrieval still works for legacy-to-new migrations in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/integration/retrieval-benchmark.integration.test.ts`

### Implementation for User Story 3

- [ ] T027 [US3] Harden repository/service compatibility and persistence write paths for migrated workspaces in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/db/repositories/retrievalSettingsRepository.ts` and `/Users/dm/conductor/workspaces/radioso/buffalo/backend/src/modules/settings/services/retrievalSettingsService.ts`
- [ ] T028 [US3] Update remaining tests, helpers, and fixtures to remove legacy attribute-family assumptions in `/Users/dm/conductor/workspaces/radioso/buffalo/backend/tests/support/fakes.ts` and covered unit/integration suites
- [ ] T029 [US3] Ensure retrieval settings diagnostics and quickstart flows reflect signal-policy language in relevant backend/frontend files and spec artifacts

**Checkpoint**: User Story 3 is complete when legacy workspaces read, save, and retrieve cleanly under the new model.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and artifact alignment across all stories.

- [ ] T030 [P] Run the quickstart validation flow from `/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/quickstart.md`
- [ ] T031 Verify changed code and generated artifacts stay within `/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/spec.md` and `/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/plan.md` scope
- [ ] T032 [P] Update completion markers and residual-risk notes in `/Users/dm/conductor/workspaces/radioso/buffalo/specs/028-signal-policy-engine/tasks.md`

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Starts after Foundational and delivers the public API/UI rename
- **User Story 2 (Phase 4)**: Depends on the signal-policy seam from Foundational and the public settings model from User Story 1
- **User Story 3 (Phase 5)**: Depends on Foundational and benefits from the completed API/retrieval wiring in User Stories 1 and 2
- **Polish (Phase 6)**: Depends on all desired stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2 with no dependency on other stories
- **User Story 2 (P2)**: Depends on the new signal-policy domain model and settings plumbing from Phases 2 and 3
- **User Story 3 (P3)**: Depends on Phases 2 and 3 and validates the migration behavior after the new contract is in place

### Within Each User Story

- Backend tests must be written and fail before implementation tasks for that story
- New domain and repository/service seams should land before route/UI wiring uses them
- Code-first OpenAPI updates must precede generated OpenAPI regeneration
- Changes to `retrievalSettingsRepository.ts`, `settingsRoutes.ts`, `document.ts`, and `settings-view.tsx` should stay sequential when tasks touch the same file
- Responsibility-limited files must stay orchestration-only or UI-only as defined in `plan.md`

### Parallel Opportunities

- T004-T008 can run in parallel once the initial seam review is done
- US1 contract and integration tests in T010-T011 can run in parallel
- US2 parser/evaluator refactors T020-T022 can be split across disjoint files before T023 integrates them
- US3 compatibility tests T024-T026 can run in parallel

---

## Parallel Example: User Story 2

```bash
# Retrieval-domain tests for the new generic policy path
Task: "T017 [US2] Add generic constraint parsing coverage in backend/tests/unit/hybrid-query-constraints.test.ts"
Task: "T018 [US2] Add evaluator-driven scoring coverage in backend/tests/unit/edge-cases.test.ts"
Task: "T019 [US2] Add retrieval stage coverage in backend/tests/unit/retrieval-pipeline-stages.test.ts"

# Retrieval-domain implementation on disjoint files
Task: "T020 [US2] Update retrieval-domain constraint types"
Task: "T021 [US2] Refactor query parsing and query stripping"
Task: "T022 [US2] Introduce typed signal evaluators and scoring dispatch"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases
2. Deliver the retrieval settings API and UI rename to `signalPolicies`
3. Validate legacy workspace loading and settings save/reload behavior
4. Stop and demo before deeper retrieval refactoring if needed

### Incremental Delivery

1. Establish the signal-policy domain, migration, and repository compatibility
2. Deliver User Story 1 as the public API/UI shift
3. Deliver User Story 2 by replacing family-specific retrieval scoring with evaluator-based dispatch
4. Deliver User Story 3 by hardening and validating legacy workspace compatibility end to end
5. Finish with quickstart validation and artifact cleanup

### Parallel Team Strategy

With multiple engineers after the foundational phase:

- Engineer A: retrieval settings persistence, routes, and OpenAPI changes
- Engineer B: retrieval-domain parser/evaluator refactor
- Engineer C: frontend retrieval settings editor and client updates
