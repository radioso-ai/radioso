# Tasks: Triggered Retrieval Filters

**Input**: Design documents from `/specs/048-triggered-retrieval-filters/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend TDD is required. Each backend slice starts with failing tests before implementation. Frontend coverage is added for changed retrieval-settings editing behavior and trace presentation as needed.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Architecture**: Keep settings persistence in the settings domain/service, trigger matching inside query interpretation, rule enactment/date evaluation/backoff inside candidate preparation and metadata rule scoring, and diagnostics/history/eval surfaces presentation-only.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh feature artifacts and establish dedicated seams before implementation

- [X] T001 Refresh `specs/048-triggered-retrieval-filters/plan.md`, `specs/048-triggered-retrieval-filters/research.md`, `specs/048-triggered-retrieval-filters/data-model.md`, and `specs/048-triggered-retrieval-filters/quickstart.md`
- [X] T002 Create the executable delivery checklist in `specs/048-triggered-retrieval-filters/tasks.md`
- [X] T003 Run `.specify/scripts/bash/update-agent-context.sh codex` and capture any additive context updates for this feature

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the focused type and helper seams required by all stories

**⚠️ CRITICAL**: No user story work should begin until this phase is complete

- [X] T004 [P] Add trigger-aware retrieval rule and dynamic-date token validation coverage in `backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [X] T005 [P] Add baseline metadata-rule dynamic date evaluation coverage in `backend/tests/unit/metadata-rule-scoring.test.ts`
- [X] T006 Add additive trigger/date fields and validation helpers in `backend/src/modules/settings/domain/retrievalSettings.ts`
- [X] T007 Add trigger-analysis and backoff result types in `backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts` and `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`
- [X] T008 Extract focused trigger-analysis and dynamic-date helper modules under `backend/src/modules/retrieval/services/` so query interpretation and metadata scoring do not absorb mixed concerns

**Checkpoint**: Shared types and helper seams are ready for story implementation.

---

## Phase 3: User Story 1 - Enact filters only when the turn warrants it (Priority: P1) 🎯 MVP

**Goal**: Triggerable retrieval rules activate only for matching turns while workspaces without configured triggers skip analysis entirely.

**Independent Test**: Configure triggerable and non-triggerable rules, run matched and unmatched turns, and verify trigger analysis skips when unconfigured and activates only the intended rules when configured.

### Tests for User Story 1 (REQUIRED for backend)

- [X] T009 [P] [US1] Add retrieval settings contract coverage for triggerable rules in `backend/tests/contract/settings.contract.test.ts`
- [X] T010 [P] [US1] Add query-interpretation skip/match/multi-match coverage in `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [X] T011 [P] [US1] Add candidate preparation coverage for trigger-enacted rules and backoff behavior in `backend/tests/unit/candidate-preparation-stage.test.ts`
- [X] T012 [P] [US1] Add end-to-end chat retrieval integration coverage for matched, unmatched, and skip flows in `backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [X] T013 [US1] Extend retrieval settings transport schemas in `backend/src/app/http/routes/settingsRoutes.ts` and `backend/src/app/http/openapi/document.ts`
- [X] T014 [US1] Persist and normalize additive trigger fields in `backend/src/modules/settings/domain/retrievalSettings.ts`, `backend/src/modules/settings/services/retrievalSettingsService.ts`, and `backend/src/db/repositories/retrievalSettingsRepository.ts`
- [X] T015 [US1] Implement completion-authoritative trigger matching and skip-if-unconfigured flow in `backend/src/modules/retrieval/services/queryRewriteService.ts`, `backend/src/modules/retrieval/services/queryInterpretationStage.ts`, and any new trigger-analysis helper modules under `backend/src/modules/retrieval/services/`
- [X] T016 [US1] Enact matched trigger rules and keep unmatched trigger rules inactive in `backend/src/modules/retrieval/services/candidatePreparationStage.ts` and `backend/src/modules/retrieval/services/metadataRuleScoringService.ts`
- [X] T017 [US1] Regenerate generated OpenAPI artifacts in `backend/openapi.yaml` and `backend/openapi.json`

**Checkpoint**: Triggerable rules work for matched and unmatched turns, and no-config workspaces skip the matcher.

---

## Phase 4: User Story 3 - Use relative date semantics without constant manual edits (Priority: P2)

**Goal**: Date-oriented retrieval rules can use `today()` safely and predictably.

**Independent Test**: Save supported date rules using `today()`, evaluate them under different effective dates, and verify invalid usage fails safely.

### Tests for User Story 3 (REQUIRED for backend)

- [X] T018 [P] [US3] Add invalid and valid `today()` validation coverage in `backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [X] T019 [P] [US3] Add metadata rule scoring coverage for `today()` date comparisons in `backend/tests/unit/metadata-rule-scoring.test.ts`
- [X] T020 [P] [US3] Add retrieval integration coverage for dynamic date evaluation in `backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 3

- [X] T021 [US3] Implement bounded `today()` token parsing and validation in `backend/src/modules/settings/domain/retrievalSettings.ts`
- [X] T022 [US3] Resolve dynamic date tokens at rule-evaluation time in `backend/src/modules/retrieval/services/metadataRuleScoringService.ts` and any extracted helper modules under `backend/src/modules/retrieval/services/`
- [X] T023 [US3] Expose supported dynamic date semantics through settings transport/client types in `frontend/lib/api.ts` and `backend/src/app/http/openapi/document.ts`

**Checkpoint**: Dynamic date comparisons are supported safely without manual settings churn.

---

## Phase 5: User Story 4 - Inspect and replay why a filter matched (Priority: P2)

**Goal**: Trigger decisions, considered rules, and backoff behavior are visible in retrieval info, trace, history, and eval replay.

**Independent Test**: Run a trigger-aware turn, inspect chat history and eval replay, and verify the trigger-analysis node plus any backoff decision are preserved and comparable.

### Tests for User Story 4 (REQUIRED for backend)

- [X] T024 [P] [US4] Add retrieval trace assembler coverage for trigger-analysis stages in `backend/tests/unit/retrieval-trace-assembler.test.ts`
- [X] T025 [P] [US4] Add retrieval info presenter coverage for trigger diagnostics in `backend/tests/unit/hybrid-retrieval-info.test.ts`
- [X] T026 [P] [US4] Add chat history replay coverage for trigger debug metadata in `backend/tests/unit/chat-history-service.test.ts`
- [X] T027 [P] [US4] Add eval replay coverage for trigger diagnostics parity in `backend/tests/unit/eval-replay-service.test.ts`
- [X] T028 [P] [US4] Add integration coverage for auditable trigger diagnostics in `backend/tests/integration/chat.integration.test.ts` and `backend/tests/integration/evals.integration.test.ts`

### Implementation for User Story 4

- [X] T029 [US4] Extend retrieval diagnostics creation in `backend/src/modules/retrieval/services/retrievalDiagnosticsStage.ts`, `backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts`, and `backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [X] T030 [US4] Add the logical trigger-analysis node and backoff details in `backend/src/modules/retrieval/services/retrievalTraceAssembler.ts` and `backend/src/modules/retrieval/services/retrievalTracePresenter.ts`
- [X] T031 [US4] Surface trigger diagnostics in `backend/src/modules/retrieval/services/retrievalInfoPresenter.ts`, `backend/src/modules/chat/services/chatHistoryService.ts`, and `backend/src/modules/evals/services/evalReplayService.ts`

**Checkpoint**: Operators can inspect and replay trigger decisions and fallback behavior across the existing diagnostics surfaces.

---

## Phase 6: User Story 5 - Configure filters in a more understandable UI (Priority: P3)

**Goal**: Retrieval settings authoring makes always-on vs trigger-based behavior, boost vs filter mode, and `today()` usage understandable and convenient.

**Independent Test**: Edit trigger-aware rules in the retrieval settings panel, save, reload, and verify the UI preserves readable trigger/date state and clear operator language.

### Tests for User Story 5

- [X] T032 [P] [US5] Add frontend retrieval-settings rule editing coverage in `frontend/tests/unit/` for trigger mode and dynamic date affordances

### Implementation for User Story 5

- [X] T033 [US5] Extend retrieval settings client types in `frontend/lib/api.ts`
- [X] T034 [US5] Refresh trigger-aware rule authoring and `today()` affordances in `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
- [X] T035 [US5] Update retrieval trace detail and dashboard diagnostics views for trigger-analysis readability in `frontend/components/dashboard/chat-retrieval-trace-detail.tsx`, `frontend/components/dashboard/chat-history-view.tsx`, and `frontend/components/dashboard/evals-view.tsx`

**Checkpoint**: Operators can author and inspect trigger-aware rules from the existing settings and diagnostics surfaces.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final docs, validation, review artifacts, and closeout work

- [X] T036 [P] Update operator-facing retrieval settings docs in `frontend/docs/settings-docs/` for trigger-based rules and `today()` semantics
- [X] T037 Review `readme.md` and update it if the changed retrieval settings are part of the key operator-facing tuning flow
- [X] T038 Run targeted backend and frontend validation for feature 048 and record residual risks in `specs/048-triggered-retrieval-filters/tasks.md`
- [X] T039 Mark completed tasks and residual notes in `specs/048-triggered-retrieval-filters/tasks.md`
- [X] T040 Run senior engineer review loop, manager pass, and prepare PR summary linked to `specs/048-triggered-retrieval-filters/spec.md`, `plan.md`, and `tasks.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup
- **US1 (Phase 3)**: Depends on Foundational
- **US3 (Phase 4)**: Depends on US1’s trigger-aware rule shape and candidate-enactment seam
- **US4 (Phase 5)**: Depends on US1 and US3 diagnostics fields existing
- **US5 (Phase 6)**: Depends on the backend contract and diagnostics shape from earlier phases
- **Polish (Phase 7)**: Depends on implemented stories

### User Story Dependencies

- **US1** establishes the persisted trigger model and matcher skip/enactment flow that all other stories rely on.
- **US3** builds on the rule model from US1 but remains focused on dynamic date semantics.
- **US4** depends on the trigger/backoff facts from US1 and US3 being produced.
- **US5** depends on the final contract and diagnostics shape from the backend stories.

### Within Each User Story

- Backend tests must be written and fail before implementation.
- Focused helper modules land before orchestration wiring when the plan calls for new seams.
- Domain validation and persistence precede transport/client wiring.
- Diagnostics presentation follows the underlying structured data changes.

### Parallel Opportunities

- T004 and T005 can be written in parallel before the foundational implementation.
- Within US1, T009–T012 can be developed in parallel as red tests.
- Within US4, trace/info/history/eval test coverage tasks can run in parallel.
- UI work in T034 and diagnostics-view work in T035 can proceed separately once the backend contracts settle.

## Implementation Strategy

### MVP First

1. Refresh artifacts and shared seams.
2. Land US1 end to end with failing tests first.
3. Validate trigger skip, match, and unmatched behavior before moving on.

### Incremental Delivery

1. Add dynamic date support after trigger enactment is stable.
2. Add auditability surfaces after the underlying data exists.
3. Finish with UI clarity improvements and documentation updates.

## Residual Risks

- Completion-based trigger matching will need careful bounded-output normalization so malformed model output degrades safely instead of creating false positives.
- The retrieval settings panel is already large; minor helper extraction may be needed during implementation to keep it responsibility-limited.

## Validation Notes

- `backend`: `npm run generate:openapi`
- `backend`: `npx vitest run tests/unit/retrieval-settings-and-chunking.test.ts tests/unit/metadata-rule-scoring.test.ts tests/unit/retrieval-pipeline-stages.test.ts tests/unit/candidate-preparation-stage.test.ts tests/unit/hybrid-retrieval-info.test.ts tests/unit/retrieval-trace-assembler.test.ts tests/unit/chat-history-service.test.ts tests/unit/eval-replay-service.test.ts tests/contract/settings.contract.test.ts tests/integration/chat.integration.test.ts tests/integration/evals.integration.test.ts`
- `frontend`: `npm test -- --run tests/unit/retrieval-rule-helpers.test.ts tests/unit/retrieval-trace-diagnostics.test.tsx`

## Review Notes

- Senior engineer review pass: no blocking findings after diff review and green targeted validation.
- Engineering manager pass: delivered scope matches `specs/048-triggered-retrieval-filters/spec.md` without scope expansion; ready for PR packaging once branch push succeeds.
