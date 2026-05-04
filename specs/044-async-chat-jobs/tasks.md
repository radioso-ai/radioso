# Tasks: Chat Execution Classes

**Input**: Design documents from `/specs/044-async-chat-jobs/`  
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md

**Tests**: Backend tests are REQUIRED and must be written before implementation for each affected slice. Documentation and operator-guidance verification follow the approved quickstart.

**Organization**: Tasks are grouped by user story to preserve the module ownership defined in `plan.md` and to keep each slice independently testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (`[US1]`, `[US2]`, etc.)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh the approved artifacts and confirm the exact code/doc seams before implementation.

- [ ] T001 Reconcile the approved feature artifacts in `specs/044-async-chat-jobs/spec.md`, `plan.md`, `research.md`, `data-model.md`, and `quickstart.md`
- [ ] T002 [P] Review the existing live chat and bootstrap seams in `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/chat/services/chatBootstrapService.ts`, `backend/src/app/http/routes/chatRoutes.ts`, and `backend/src/app/http/routes/publicChatRoutes.ts`
- [ ] T003 [P] Review the async reference workflow and docs seams in `readme.md`, `docs/README.md`, and `frontend/components/dashboard/settings/settings-docs.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the shared execution-policy seam and baseline guardrail coverage before any story-specific work.

**⚠️ CRITICAL**: No user story implementation starts before this phase is complete.

- [ ] T004 [P] Add failing unit coverage for workflow classification and live-chat guardrails in `backend/tests/unit/chat-execution-policy.test.ts`
- [ ] T006 [P] Add failing integration coverage that normal chat remains on the live request path in `backend/tests/integration/chat.integration.test.ts`
- [ ] T007 [P] Add failing integration coverage that bootstrap greeting remains interactive in `backend/tests/integration/chat-bootstrap.integration.test.ts`
- [ ] T008 Create `backend/src/modules/chat/services/chatExecutionPolicy.ts` with the canonical execution-class definitions and covered workflow classifier
- [ ] T009 Add focused test helpers or fixtures for execution-class assertions in `backend/tests/support/` if needed by multiple test files

**Checkpoint**: The repository has a single source of truth for execution-class policy and failing tests that prevent silent queue-backed fallback for live chat.

---

## Phase 3: User Story 1 - Keep Live Chat Immediate (Priority: P1) 🎯 MVP

**Goal**: Preserve normal authenticated, public, embedded, and bootstrap chat as synchronous streaming interactions with explicit failure instead of background fallback.

**Independent Test**: Send normal chat requests and confirm retrieval, answer generation, streaming, and persistence remain in the live request path with no durable async handoff.

### Tests for User Story 1

- [ ] T010 [P] [US1] Extend failing unit coverage for chat streaming guardrails in `backend/tests/unit/chat-service-streaming.test.ts`
- [ ] T011 [P] [US1] Add failing public-chat guardrail coverage in `backend/tests/integration/anonymous-chat.integration.test.ts`
- [ ] T012 [P] [US1] Add failing route-level coverage for live chat behavior in `backend/tests/contract/chat.contract.test.ts` and `backend/tests/contract/public-chat.contract.test.ts`

### Implementation for User Story 1

- [ ] T013 [P] [US1] Wire `chatExecutionPolicy.ts` into `backend/src/modules/chat/services/chatService.ts` for explicit interactive classification checks
- [ ] T014 [P] [US1] Wire `chatExecutionPolicy.ts` into `backend/src/modules/chat/services/chatBootstrapService.ts` so bootstrap remains explicitly interactive
- [ ] T015 [US1] Add guardrail handling in `backend/src/app/http/routes/chatRoutes.ts` and `backend/src/app/http/routes/publicChatRoutes.ts` so live chat does not silently downgrade into deferred background work
- [ ] T016 [US1] Ensure any live-chat overload/cancellation behavior remains explicit and documented in `backend/src/modules/chat/services/chatService.ts` and related route tests

**Checkpoint**: Normal chat is explicitly protected as interactive and cannot drift into queue-backed behavior unnoticed.

---

## Phase 4: User Story 2 - Run Long Jobs Reliably (Priority: P1)

**Goal**: Define the future deferred category clearly enough that long-running assistant-adjacent work has a credible enterprise story without pretending this feature already ships a generic async runtime.

**Independent Test**: Classify covered workflows, then verify future deferred candidates are documented honestly without claiming a shipped durable-background runtime.

### Tests for User Story 2

- [ ] T017 [P] [US2] Add failing unit coverage for future deferred workflow classification in `backend/tests/unit/chat-execution-policy.test.ts`
### Implementation for User Story 2

- [ ] T019 [P] [US2] Extend `backend/src/modules/chat/services/chatExecutionPolicy.ts` with the future deferred workflow category and explanatory metadata
- [ ] T021 [US2] Add or update any shared types or internal metadata needed to expose execution-class decisions without introducing a new public API

**Checkpoint**: The codebase has an explicit future deferred category for long-running assistant work that is represented honestly as future scope.

---

## Phase 5: User Story 3 - Give Operators A Predictable Service Model (Priority: P2)

**Goal**: Make the service model predictable under load by ensuring covered workflows have one clear execution class and that interactive overload remains explicit rather than implicitly deferred.

**Independent Test**: Review the execution-policy definitions and live-chat failure behavior, then confirm each covered workflow has one clear service mode with no ambiguous middle state.

### Tests for User Story 3

- [ ] T022 [P] [US3] Add failing integration coverage for predictable live-chat failure behavior in `backend/tests/integration/chat.integration.test.ts`
- [ ] T023 [P] [US3] Add failing unit coverage that covered workflows cannot map to mixed execution classes in `backend/tests/unit/chat-execution-policy.test.ts`

### Implementation for User Story 3

- [ ] T024 [P] [US3] Add service-model helper logic in `backend/src/modules/chat/services/chatExecutionPolicy.ts` for immediate versus deferred expectations
- [ ] T025 [US3] Use the service-model helper in `backend/src/modules/chat/services/chatService.ts` and `backend/src/modules/chat/services/chatBootstrapService.ts` where guardrail assertions or audit metadata need it
- [ ] T026 [US3] Ensure future queue-everything proposals are blocked by clear anti-goal documentation or inline policy assertions rather than convention alone

**Checkpoint**: Operators and future implementers have a predictable service contract for covered assistant workflows.

---

## Phase 6: User Story 4 - Document Immediate Versus Background Work (Priority: P2)

**Goal**: Ship operator- and enterprise-facing documentation that explains the difference between live chat and any future deferred assistant work in plain language.

**Independent Test**: Use the shipped documentation alone to classify each covered workflow and explain how future deferred work would differ from normal chat.

### Tests for User Story 4

- [ ] T027 [P] [US4] Add documentation verification notes or lightweight coverage hooks for execution-model references in `backend/tests/integration/` or repo validation scripts if present

### Implementation for User Story 4

- [ ] T028 [P] [US4] Update `readme.md` with the approved service-model explanation for live chat versus any future deferred assistant work
- [ ] T029 [P] [US4] Add `docs/assistant-execution-model.md` with plain-language operator and enterprise guidance
- [ ] T030 [P] [US4] Update `docs/README.md` to link the new execution-model guide
- [ ] T031 [US4] Update `frontend/components/dashboard/settings/settings-docs.ts` and `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` only if in-product operator guidance is needed for this feature

**Checkpoint**: The distinction between immediate and background assistant work is understandable without reading source code.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, task reconciliation, and cleanup across all stories.

- [ ] T032 [P] Run the quickstart validation scenarios from `specs/044-async-chat-jobs/quickstart.md`
- [ ] T033 [P] Run targeted backend validation for `backend/tests/unit/chat-execution-policy.test.ts`, `backend/tests/unit/chat-service-streaming.test.ts`, `backend/tests/integration/chat.integration.test.ts`, `backend/tests/integration/chat-bootstrap.integration.test.ts`, and `backend/tests/integration/anonymous-chat.integration.test.ts`
- [ ] T034 Reconcile task completion state and feature notes across `specs/044-async-chat-jobs/`
- [ ] T035 Perform final cleanup to confirm `chatService.ts`, `chatBootstrapService.ts`, and chat route files remained responsibility-limited

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all story work
- **User Stories (Phases 3-6)**: Depend on Foundational completion
- **Polish (Phase 7)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational and delivers the MVP guardrail for live chat
- **US2 (P1)**: Starts after Foundational and reuses the execution-policy seam
- **US3 (P2)**: Starts after Foundational and depends on the policy seam plus live-chat guardrails
- **US4 (P2)**: Starts after Foundational and depends on the approved execution policy being implemented clearly enough to document

### Within Each User Story

- Backend tests MUST fail before implementation
- The execution-policy seam lands before any route or service wiring that depends on it
- Live chat guardrails land before documentation claims are finalized
- Docs ship after the policy and service-model behavior are stable enough to describe accurately

### Parallel Opportunities

- Foundational tests can run in parallel across unit and integration files
- US1 route and bootstrap tasks can run in parallel after the policy seam exists
- US4 documentation tasks can run in parallel across `readme.md`, `docs/assistant-execution-model.md`, and `docs/README.md`

---

## Parallel Example: User Story 1

```bash
# Launch failing live-chat guardrail coverage together:
Task: "Extend failing unit coverage for chat streaming guardrails in backend/tests/unit/chat-service-streaming.test.ts"
Task: "Add failing public-chat guardrail coverage in backend/tests/integration/anonymous-chat.integration.test.ts"
Task: "Add failing route-level coverage for live chat behavior in backend/tests/contract/chat.contract.test.ts and backend/tests/contract/public-chat.contract.test.ts"

# After the policy seam exists, wire the guarded flows in parallel:
Task: "Wire chatExecutionPolicy.ts into backend/src/modules/chat/services/chatService.ts for explicit interactive classification checks"
Task: "Wire chatExecutionPolicy.ts into backend/src/modules/chat/services/chatBootstrapService.ts so bootstrap remains explicitly interactive"
```

---

## Implementation Strategy

### MVP First (US1)

1. Complete Setup + Foundational
2. Deliver US1 so normal chat is explicitly protected as live interaction
3. Validate live-chat guardrails before broadening the async classification story

### Incremental Delivery

1. Add the execution-policy seam and guardrail tests
2. Protect normal chat and bootstrap flows
3. Classify the current workflow set while keeping future deferred candidates explicit
4. Clarify the operator service model
5. Ship documentation and validation

### Review Strategy

1. Complete implementation and targeted validation
2. Run a separate review pass focused on regressions, missing tests, and architecture drift
3. Confirm docs and code describe the same service model before merge readiness

## Notes

- [P] tasks touch different files and avoid same-file conflicts
- No backend HTTP contract change is expected in this feature
- Runtime prompt assets are not expected, but if any are introduced they must live under `backend/prompts/`
- Keep live chat and any future deferred assistant work as separate product modes throughout the implementation
