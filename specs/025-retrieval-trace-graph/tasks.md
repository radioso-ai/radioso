# Tasks: Retrieval Trace Graph

**Input**: Design documents from `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED and must be written before implementation. Frontend verification follows the approved spec and quickstart.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm scope, target files, and existing retrieval/chat contracts before additive trace work begins.

- [ ] T001 Review `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/spec.md`, `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/plan.md`, and current retrieval/chat files under `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/`, `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/chat/`, and `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/`
- [ ] T002 [P] Inventory current chat payload and history contract touchpoints in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/openapi/document.ts`, `/Users/dm/conductor/workspaces/radioso/auckland/frontend/lib/api.ts`, and `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/`
- [ ] T003 [P] Review and preserve the existing audit replay path in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/chat/services/chatHistoryService.ts`, `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/chat/services/chatService.ts`, and `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/audit/services/auditService.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish trace domain types, bounded assembly seams, and additive contract wiring before any story-specific UI or history work.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Write failing backend unit coverage for `RetrievalTrace` domain shaping in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/retrieval-trace.test.ts`
- [ ] T005 [P] Write failing backend unit coverage for bounded trace stage status and reason behavior in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/retrieval-trace.test.ts`
- [ ] T006 [P] Define additive retrieval trace domain types in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [ ] T007 [P] Create a focused retrieval trace assembler in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalTraceAssembler.ts`
- [ ] T008 [P] Create a focused retrieval trace presenter in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalTracePresenter.ts`
- [ ] T009 Extend `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalPipelineService.ts` and `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalDiagnosticsStage.ts` so pipeline execution returns both compact diagnostics inputs and trace assembly inputs without moving UI logic into those files
- [ ] T010 Add additive retrieval-trace schemas to `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/openapi/document.ts`
- [ ] T011 Regenerate generated OpenAPI artifacts from `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/openapi/document.ts` into `/Users/dm/conductor/workspaces/radioso/auckland/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/auckland/backend/openapi.json`

**Checkpoint**: Trace domain, assembly, and additive HTTP schema ownership are in place.

---

## Phase 3: User Story 1 - Inspect One Answer Trace (Priority: P1) 🎯 MVP

**Goal**: Expose a readable retrieval trace for a completed answer in the live chat flow without breaking the existing compact retrieval summary.

**Independent Test**: Execute a retrieval-backed chat request and confirm the returned answer includes both `retrievalInfo` and a graph-ready `retrievalTrace` whose stages match the executed retrieval path.

### Tests for User Story 1 (REQUIRED for backend)

- [ ] T012 [P] [US1] Write failing backend contract coverage for additive `retrievalTrace` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/chat.contract.test.ts`
- [ ] T013 [P] [US1] Write failing backend JSON and streaming chat-service coverage for `retrievalTrace` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/chat-service-streaming.test.ts`
- [ ] T014 [P] [US1] Write failing backend integration coverage for live chat trace payloads in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [ ] T015 [US1] Attach additive `retrievalTrace` data in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/chat/services/chatService.ts`
- [ ] T016 [US1] Expose additive `retrievalTrace` on JSON and SSE completion payloads in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/presenters/chatPresenter.ts`
- [ ] T017 [US1] Extend frontend chat response and stream parsing for `retrievalTrace` in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/lib/api.ts`
- [ ] T018 [US1] Carry additive `retrievalTrace` through live chat state in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/lib/chat-context.tsx` and `/Users/dm/conductor/workspaces/radioso/auckland/frontend/lib/anonymous-chat-context.tsx`
- [ ] T019 [P] [US1] Create the live retrieval trace graph component in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-graph.tsx`
- [ ] T020 [P] [US1] Create the retrieval trace detail and raw-trace panel in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-detail.tsx`
- [ ] T021 [US1] Render the live retrieval trace alongside the existing compact summary in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-view.tsx` and `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-info.tsx`

**Checkpoint**: User Story 1 is independently functional and delivers the MVP operator trace for a live answer.

---

## Phase 4: User Story 2 - Drill Into Stage Decisions (Priority: P2)

**Goal**: Make each graph node diagnostically useful with bounded settings, inputs, outputs, metrics, statuses, and reasons.

**Independent Test**: Execute representative queries that produce applied, skipped, fallback, rejected, and no-context outcomes and verify the selected node details explain the stage decision without exposing prohibited sensitive content.

### Tests for User Story 2 (REQUIRED for backend)

- [ ] T022 [P] [US2] Write failing backend unit coverage for stage-specific trace content and branch links in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/retrieval-trace.test.ts`
- [ ] T023 [P] [US2] Write failing backend unit coverage for bounded-data exclusion rules in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/retrieval-trace.test.ts`
- [ ] T024 [P] [US2] Write failing frontend component coverage or fixture-driven verification for node detail rendering in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-detail.tsx`

### Implementation for User Story 2

- [ ] T025 [US2] Expand `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalTraceAssembler.ts` to emit stable stage ids, stage links, status categories, metrics, and reason text for context, interpretation, candidate retrieval branches, preparation, selection, prompt assembly, answer outcome, and diagnostics
- [ ] T026 [US2] Add bounded-field shaping and redaction rules in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalTracePresenter.ts`
- [ ] T027 [US2] Extend compact-summary alignment rules between `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalTracePresenter.ts` and `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/retrieval/services/retrievalInfoPresenter.ts`
- [ ] T028 [US2] Implement graph node styling and status treatment for applied, skipped, fallback, rejected, unavailable, and failed stages in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-graph.tsx`
- [ ] T029 [US2] Implement stage selection, detail rendering, and raw JSON inspection in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-detail.tsx`
- [ ] T030 [US2] Add readable copy, empty states, and bounded-value presentation for trace details in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-detail.tsx` and `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-info.tsx`

**Checkpoint**: User Stories 1 and 2 are independently functional and stage drill-down is diagnostically useful.

---

## Phase 5: User Story 3 - Review Historical Traces In Chat History (Priority: P3)

**Goal**: Persist and replay retrieval traces for assistant turns so operators can inspect current and historical answers in chat history.

**Independent Test**: Run a multi-turn conversation, reopen it in chat history, and confirm newer assistant answers replay their stored `retrievalTrace` while older turns without stored traces show an explicit unavailable state.

### Tests for User Story 3 (REQUIRED for backend)

- [ ] T031 [P] [US3] Write failing backend contract coverage for historical `retrievalTrace` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/chat.contract.test.ts`
- [ ] T032 [P] [US3] Write failing backend history-service coverage for replayed and unavailable traces in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/chat-history-service.test.ts`
- [ ] T033 [P] [US3] Write failing backend integration coverage for history trace replay in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 3

- [ ] T034 [US3] Persist additive `retrievalTrace` in assistant-turn audit metadata in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/chat/services/chatService.ts` and `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/audit/services/auditService.ts`
- [ ] T035 [US3] Replay stored `retrievalTrace` and unavailable-state metadata in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/chat/services/chatHistoryService.ts`
- [ ] T036 [US3] Extend history-related API types for trace replay in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/lib/api.ts`
- [ ] T037 [US3] Reuse the trace graph/detail components for history inspection in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-history-view.tsx`
- [ ] T038 [US3] Add explicit unavailable-state presentation for historical answers without stored traces in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-history-view.tsx` and `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-detail.tsx`

**Checkpoint**: All user stories are independently functional and historical trace replay works through the existing audit path.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, regression checks, and documentation alignment across all stories.

- [ ] T039 [P] Refresh feature guidance in `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/quickstart.md` and `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/contracts/retrieval-trace-contract.md` if implementation details drift
- [ ] T040 Run affected backend unit, contract, and integration suites in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/`
- [ ] T041 [P] Regenerate and verify `/Users/dm/conductor/workspaces/radioso/auckland/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/auckland/backend/openapi.json` against the code-first registry in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/openapi/document.ts`
- [ ] T042 [P] Run targeted frontend verification for live chat trace rendering and history trace replay in `/Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/`
- [ ] T043 Re-read `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/spec.md`, `/Users/dm/conductor/workspaces/radioso/auckland/specs/025-retrieval-trace-graph/plan.md`, and changed code to verify scope fit before review handoff

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion and is the suggested MVP slice
- **User Story 2 (Phase 4)**: Depends on User Story 1 because stage drill-down depends on the live trace contract and reusable trace components
- **User Story 3 (Phase 5)**: Depends on User Story 1 for base trace payloads and can begin after the audit persistence contract is settled
- **Polish (Phase 6)**: Depends on all desired story work being complete

### User Story Dependencies

- **US1**: Independent after Foundational and is the recommended MVP
- **US2**: Depends on the `RetrievalTrace` shape from US1 but remains independently testable once live trace delivery exists
- **US3**: Depends on the additive trace contract from US1 and remains independently testable through chat-history replay

### Within Each User Story

- Backend tests must be written and fail before implementation
- Trace domain and presenter extractions must land before `chatService.ts` or `chatHistoryService.ts` grows new behavior
- The OpenAPI registry must be updated before generated artifact refresh and contract verification
- Reusable frontend trace components should land before both live chat and history views consume them
- Existing responsibility-limited files must stay orchestration-only or presentation-only

### Parallel Opportunities

- T002 and T003 can run in parallel
- T005-T008 can run in parallel after T004 establishes failing trace tests
- T012-T014 can run in parallel
- T019 and T020 can run in parallel
- T022-T024 can run in parallel
- T031-T033 can run in parallel
- T041 and T042 can run in parallel after implementation stabilizes

---

## Parallel Example: User Story 1

```bash
Task: "Write failing backend contract coverage for additive retrievalTrace in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/chat.contract.test.ts"
Task: "Write failing backend JSON and streaming chat-service coverage for retrievalTrace in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/chat-service-streaming.test.ts"
Task: "Write failing backend integration coverage for live chat trace payloads in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/integration/chat.integration.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Write failing backend unit coverage for stage-specific trace content and branch links in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/retrieval-trace.test.ts"
Task: "Write failing backend unit coverage for bounded-data exclusion rules in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/retrieval-trace.test.ts"
Task: "Write failing frontend component coverage or fixture-driven verification for node detail rendering in /Users/dm/conductor/workspaces/radioso/auckland/frontend/components/dashboard/chat-retrieval-trace-detail.tsx"
```

## Parallel Example: User Story 3

```bash
Task: "Write failing backend contract coverage for historical retrievalTrace in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/chat.contract.test.ts"
Task: "Write failing backend history-service coverage for replayed and unavailable traces in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/chat-history-service.test.ts"
Task: "Write failing backend integration coverage for history trace replay in /Users/dm/conductor/workspaces/radioso/auckland/backend/tests/integration/chat.integration.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate live chat trace rendering independently before adding deeper drill-down or history replay

### Incremental Delivery

1. Add trace domain types, assembler, presenter, and additive OpenAPI schemas
2. Add live chat `retrievalTrace` delivery and graph rendering
3. Add stage drill-down, reason text, bounded raw trace view, and status treatment
4. Add audit persistence and history replay for stored traces
5. Run final contract, regression, and UI verification

### Parallel Team Strategy

1. One engineer owns backend trace domain, assembly, and OpenAPI schema updates
2. One engineer owns live chat transport and frontend graph/detail components after the trace contract stabilizes
3. One engineer owns audit persistence and history replay once the base trace payload is available

## Notes

- Total tasks: 43
- User story task counts: US1 = 10, US2 = 9, US3 = 8
- Suggested MVP scope: Phase 3 / User Story 1
- Parallel opportunities identified in Setup, Foundational, each user-story test phase, and final verification
- Independent test criteria:
  - US1: live chat answer returns and renders `retrievalTrace`
  - US2: selected stage explains settings, inputs, outputs, metrics, and reasons with bounded data
  - US3: chat history replays stored traces and shows explicit unavailable states for older answers
- All tasks follow the required checklist format with task id, labels, and file paths
