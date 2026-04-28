# Tasks: Conversational Unsupported Answers

**Input**: Design documents from `/specs/039-unsupported-answer-refine/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend tests are REQUIRED and must be written before implementation.

**Organization**: Tasks are grouped by user story so each story remains
independently testable.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh feature artifacts and agent context before code changes

- [x] T001 Run `.specify/scripts/bash/update-agent-context.sh codex` from `/Users/dm/conductor/workspaces/radioso/madison-v1`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the ownership seam that all user stories will use

- [x] T002 Create the grounded miss response composer module in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/modules/chat/services/groundedMissResponseComposer.ts`
- [x] T003 Wire the new composer through `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/shared/infra/llm/providerRegistry.ts`, `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/app/server/dependencies.ts`, and `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/support/testApp.ts`

**Checkpoint**: Domain seam exists and orchestration can depend on it without
owning wording rules.

---

## Phase 3: User Story 1 - Helpful Unsupported Response From Retrieved Material (Priority: P1) 🎯 MVP

**Goal**: Replace the fully unsupported strict-mode dead end with a
conversational grounded miss that can point to adjacent retrieved material.

**Independent Test**: Force a fully unsupported strict-mode answer with related
retrieved context and verify the response explicitly states the miss, offers a
bounded adjacent suggestion, and preserves the degraded unsupported outcome.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T004 [P] [US1] Add unit coverage for grounded-miss composition in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/grounded-miss-response-composer.test.ts`
- [x] T005 [P] [US1] Update strict unsupported chat service unit coverage in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/chat-service-streaming.test.ts`
- [x] T006 [P] [US1] Update fully unsupported chat integration coverage in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [x] T007 [US1] Extend `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/modules/chat/services/answerSupportValidator.ts` to use the composer for fully unsupported strict-mode responses while preserving existing mixed-answer behavior
- [x] T008 [US1] Update `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/modules/chat/services/chatService.ts` to inject and pass the composer without adding wording rules to the service
- [x] T009 [US1] Update `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/modules/evals/services/evalReplayService.ts` to reuse the composer for fully unsupported replay behavior

**Checkpoint**: Fully unsupported strict-mode turns now return conversational
grounded misses and remain independently testable.

---

## Phase 4: User Story 2 - Safe No-Context Response Without Scope Expansion (Priority: P2)

**Goal**: Replace the hard-coded no-context refusal with a conversational
workspace-bounded miss that does not imply a generic answer fallback.

**Independent Test**: Send a no-context query and verify the final response is
explicit about missing workspace support, more natural than the old string, and
still classified as `no_context_refusal`.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T010 [P] [US2] Update no-context unit coverage in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/chat-service-streaming.test.ts`
- [x] T011 [P] [US2] Update no-context integration coverage in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/integration/chat.integration.test.ts`
- [x] T012 [P] [US2] Add eval replay no-context coverage in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/eval-replay-service.test.ts`

### Implementation for User Story 2

- [x] T013 [US2] Replace hard-coded no-context copy in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/modules/chat/services/chatService.ts` with composer output
- [x] T014 [US2] Replace hard-coded no-context copy in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/src/modules/evals/services/evalReplayService.ts` with composer output

**Checkpoint**: No-context turns remain safe and explicit without relying on the
old hard-coded refusal string.

---

## Phase 5: User Story 3 - Preserve Existing Policy Semantics And Diagnostics (Priority: P3)

**Goal**: Keep outcome semantics, diagnostics, and operator-facing docs aligned
with the refined presentation behavior.

**Independent Test**: Exercise supported, fully unsupported, and no-context
paths and confirm existing outcome semantics remain intact while docs describe
the new user-visible behavior.

### Tests for User Story 3 (REQUIRED for backend)

- [x] T015 [P] [US3] Verify outcome semantics remain stable in `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/integration/chat.integration.test.ts` and `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/chat-service-streaming.test.ts`

### Implementation for User Story 3

- [x] T016 [US3] Update operator-facing retrieval docs in `/Users/dm/conductor/workspaces/radioso/madison-v1/frontend/docs/settings-docs/retrieval/answer-policy.md`
- [x] T017 [US3] Review and update `/Users/dm/conductor/workspaces/radioso/madison-v1/readme.md` if the `answerPolicy` operator guidance needs wording changes

**Checkpoint**: The refined behavior is documented and outcome/debug semantics
remain unchanged.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T018 Mark completed tasks and reconcile final artifact wording in `/Users/dm/conductor/workspaces/radioso/madison-v1/specs/039-unsupported-answer-refine/tasks.md`
- [x] T019 Run targeted backend validation for `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/grounded-miss-response-composer.test.ts`, `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/chat-service-streaming.test.ts`, `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/unit/eval-replay-service.test.ts`, and `/Users/dm/conductor/workspaces/radioso/madison-v1/backend/tests/integration/chat.integration.test.ts`
- [x] T020 Run additional regression validation needed for confidence and update any affected docs or task state

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: starts immediately
- **Foundational (Phase 2)**: depends on setup
- **User Story 1 (Phase 3)**: depends on foundational seam
- **User Story 2 (Phase 4)**: depends on foundational seam and may reuse the
  same composer implementation
- **User Story 3 (Phase 5)**: depends on the completed behavior from US1 and US2
- **Polish (Phase 6)**: depends on all story phases

### Within Each User Story

- Write failing backend tests before implementation
- Keep orchestration files thin
- Update docs after behavior is settled
- Mark tasks complete as work lands

## Implementation Strategy

### MVP First

1. Add the composer seam
2. Ship US1 fully unsupported strict-mode refinement
3. Validate

### Incremental Delivery

1. Add no-context refinement
2. Preserve diagnostics and docs
3. Run broader regression validation and review
