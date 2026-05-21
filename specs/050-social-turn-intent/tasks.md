# Tasks: Model-Level Social Turn Intent

**Input**: Design documents from `/specs/050-social-turn-intent/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and must be written before implementation for each affected slice. Frontend verification is limited to targeted settings-doc and helper-copy updates.

**Organization**: Tasks are grouped by user story so each behavior slice can be validated independently while preserving the ownership seams declared in `plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (`[US1]`, `[US2]`, etc.)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Keep the feature artifacts aligned before implementation begins.

- [x] T001 Reconcile the approved feature artifacts in `specs/050-social-turn-intent/spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/social-turn-routing-contract.md`, and `quickstart.md`
- [x] T002 [P] Review the current routing seams in `backend/src/modules/chat/services/`, `backend/src/modules/retrieval/services/`, and `backend/tests/` to confirm the target files before writing tests

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the shared interpretation and answer-instruction seams that every story depends on.

**⚠️ CRITICAL**: No user story implementation starts before this phase is complete.

- [x] T003 [P] Add failing interpretation coverage for additive `responseIntent` parsing and defaults in `backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T004 [P] Add failing query-interpretation stage coverage for non-retrieval intent propagation in `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [x] T005 [P] Add failing shared answer-instruction builder coverage in `backend/tests/unit/prompt-builder.test.ts` or a new focused unit test under `backend/tests/unit/`
- [x] T006 Extend the structured rewrite contract with `responseIntent` in `backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts` and `backend/src/modules/retrieval/services/queryRewriteService.ts`
- [x] T007 Update `backend/prompts/retrieval/query-rewrite-system.md` and `backend/prompts/retrieval/query-rewrite-user.md` so the existing interpretation pass emits `responseIntent` and treats mixed turns as retrieval-first
- [x] T008 Extract a shared answer-instruction builder from `backend/src/modules/retrieval/services/promptBuilder.ts` into a focused reusable module under `backend/src/modules/retrieval/services/`
- [x] T009 Update `backend/src/modules/retrieval/services/promptBuilder.ts` and `backend/src/modules/retrieval/services/promptAssemblyStage.ts` to consume the shared answer-instruction builder without changing grounded-answer behavior

**Checkpoint**: The model interpretation contract and shared answer-instruction seam exist, so story-specific routing can build on them.

---

## Phase 3: User Story 1 - Reply Naturally To Social-Only Turns (Priority: P1) 🎯 MVP

**Goal**: Social-only turns return a natural acknowledgement, skip retrieval, and still respect workspace answer instructions.

**Independent Test**: Send `Hi`, `hello`, or `thanks`-style turns with no substantive ask and verify the reply stays conversational, uses answer instructions, and never returns the grounded-miss fallback.

### Tests for User Story 1

- [x] T010 [P] [US1] Add failing unit coverage for social-only routing decisions in `backend/tests/unit/chat-service-streaming.test.ts`
- [x] T011 [P] [US1] Add failing integration coverage for social-only turns in `backend/tests/integration/chat.integration.test.ts`
- [x] T012 [P] [US1] Add failing backend coverage that social-only replies still honor answer instructions in `backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 1

- [x] T013 [P] [US1] Create a focused chat turn-intent service in `backend/src/modules/chat/services/chatTurnIntentService.ts`
- [x] T014 [P] [US1] Add non-retrieval social prompt assets under `backend/prompts/chat/`
- [x] T015 [US1] Wire social-only routing into `backend/src/modules/chat/services/chatService.ts` using the chat turn-intent service and shared answer-instruction builder
- [x] T016 [US1] Ensure social-only turns bypass grounded-miss fallback logic in `backend/src/modules/chat/services/chatService.ts`

**Checkpoint**: Social-only turns are independently correct and no longer produce document-grounded miss replies.

---

## Phase 4: User Story 2 - Preserve Retrieval For Mixed Turns (Priority: P1)

**Goal**: Mixed turns that contain a real grounded ask continue through the normal retrieval path even when they include politeness or lightweight reaction language.

**Independent Test**: Send mixed turns such as `Thanks, and what courses are coming up?` and verify the substantive question still drives retrieval.

### Tests for User Story 2

- [x] T017 [P] [US2] Add failing interpretation coverage for mixed-turn precedence in `backend/tests/unit/chat-retrieval.domain.test.ts`
- [x] T018 [P] [US2] Add failing integration coverage for mixed-turn retrieval behavior in `backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 2

- [x] T019 [US2] Refine the interpretation prompt and normalization rules in `backend/prompts/retrieval/query-rewrite-system.md` and `backend/src/modules/retrieval/services/queryRewriteService.ts` so mixed turns stay retrieval-first
- [x] T020 [US2] Reuse precomputed interpretation in `backend/src/modules/retrieval/services/retrievalPipelineStages.ts`, `backend/src/modules/retrieval/services/queryInterpretationStage.ts`, and `backend/src/modules/chat/services/chatService.ts` so chat does not pay for duplicate model interpretation on retrieval-backed turns

**Checkpoint**: Mixed turns remain grounded and do not collapse into social-only acknowledgements.

---

## Phase 5: User Story 3 - Handle Assistant Identity Through The Same Intent Layer (Priority: P2)

**Goal**: Assistant-identity-only turns use the same model-level routing layer and remove the existing regex special case.

**Independent Test**: Ask `Who are you?` or `What can you do?` and verify the answer uses configured identity, skips retrieval, and no regex routing remains.

### Tests for User Story 3

- [x] T021 [P] [US3] Add failing unit coverage for assistant-identity intent routing in `backend/tests/unit/chat-service-streaming.test.ts`
- [x] T022 [P] [US3] Add failing integration coverage for identity-only turns in `backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 3

- [x] T023 [P] [US3] Update `backend/prompts/chat/assistant-identity-answer.md` or add a focused shared non-retrieval identity prompt so identity replies also consume shared answer instructions
- [x] T024 [US3] Remove regex-based identity detection from `backend/src/modules/chat/services/chatService.ts` and route identity-only turns through the model-level intent service

**Checkpoint**: Assistant-identity replies no longer depend on forbidden local classifiers.

---

## Phase 6: User Story 4 - Preserve Debuggability Of Non-Retrieval Routing (Priority: P3)

**Goal**: Engineers can inspect which path a turn followed and whether retrieval was intentionally skipped.

**Independent Test**: Exercise social-only, identity-only, and mixed turns and inspect stored diagnostics or audit metadata for the routing decision.

### Tests for User Story 4

- [x] T025 [P] [US4] Add failing unit coverage for additive intent-routing diagnostics in `backend/tests/unit/chat-history-service.test.ts` or another focused diagnostics test
- [x] T026 [P] [US4] Add failing integration coverage for intent-routing audit metadata in `backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 4

- [x] T027 [US4] Record additive response-intent routing metadata in `backend/src/modules/chat/services/chatService.ts`
- [x] T028 [US4] Extend retrieval or chat diagnostics presenters only as needed to keep the chosen path inspectable in existing debug surfaces under `backend/src/modules/chat/services/` and `backend/src/modules/retrieval/services/`

**Checkpoint**: Routing behavior is inspectable without a new endpoint or standalone debug store.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, artifact sync, validation, and final cleanup across stories.

- [x] T029 [P] Update the answer-instruction setting doc in `docs/settings-docs/retrieval/custom-instruction.md` and `frontend/docs/settings-docs/retrieval/custom-instruction.md`
- [x] T030 [P] Update the assistant settings helper copy in `frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx` so it no longer says answer guidance applies only to grounded responses
- [x] T031 [P] Review `readme.md` for changes required by this feature and update only if the documented operator-facing behavior is materially affected
- [x] T032 Reconcile generated artifact wording and task completion state in `specs/050-social-turn-intent/`
- [x] T033 Run the validation scenarios from `specs/050-social-turn-intent/quickstart.md`
- [x] T034 Run targeted backend validation for the completed feature
- [x] T035 Perform final code cleanup and verify no responsibility-limited files absorbed forbidden routing logic

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all story work
- **User Stories (Phases 3-6)**: Depend on Foundational completion
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational; delivers the visible social-only fix
- **US2 (P1)**: Starts after Foundational and reuses the shared interpretation seam from Phase 2
- **US3 (P2)**: Starts after Foundational and can reuse the same non-retrieval routing seam as US1
- **US4 (P3)**: Starts after Foundational and depends on the final routing path being in place

### Within Each User Story

- Backend tests MUST fail before implementation
- Shared instruction-building seams land before non-retrieval prompt wiring
- Routing decisions land before diagnostics and docs
- Remove forbidden regex logic only after the model-level replacement path exists

### Parallel Opportunities

- Foundational prompt-contract and shared-instruction tests can run in parallel
- Social-only prompt assets and chat turn-intent service can be built in parallel
- Docs and helper-copy updates can run in parallel during the polish phase

---

## Parallel Example: User Story 1

```bash
# Launch failing backend coverage together:
Task: "Add failing unit coverage for social-only routing decisions in backend/tests/unit/chat-service-streaming.test.ts"
Task: "Add failing integration coverage for social-only turns in backend/tests/integration/chat.integration.test.ts"
Task: "Add failing backend coverage that social-only replies still honor answer instructions in backend/tests/unit/chat-service-streaming.test.ts"

# Build focused non-retrieval seams in parallel:
Task: "Create a focused chat turn-intent service in backend/src/modules/chat/services/chatTurnIntentService.ts"
Task: "Add non-retrieval social prompt assets under backend/prompts/chat/"
```

---

## Implementation Strategy

### MVP First (US1)

1. Complete Setup + Foundational
2. Deliver social-only routing with shared answer instructions
3. Validate that social-only replies no longer hit grounded-miss fallback

### Incremental Delivery

1. Extend the interpretation contract with `responseIntent`
2. Extract the shared answer-instruction builder
3. Add social-only routing
4. Preserve mixed-turn retrieval behavior
5. Move assistant identity to the same model-level path
6. Add diagnostics, docs, and final validation

### Review Strategy

1. Complete implementation and targeted validation
2. Run a separate review pass focused on regressions, missing tests, and architecture drift
3. Apply review fixes before creating the merge request

## Notes

- [P] tasks touch different files and avoid same-file conflicts
- This feature does not add a new public HTTP endpoint
- Runtime prompt assets belong under `backend/prompts/`
- The final code must not reintroduce deterministic keyword or regex routing for greetings, thanks, or assistant identity
