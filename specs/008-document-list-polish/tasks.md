# Tasks: Document List Polish

**Input**: Design documents from `/specs/008-document-list-polish/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before backend implementation tasks. Frontend validation follows the approved quickstart scenarios.

**Organization**: Tasks are grouped by user story so each story can be completed and validated independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Align artifacts and scope before code changes

- [x] T001 Confirm implementation scope against `/tmp/hivec-document-list-polish/specs/008-document-list-polish/spec.md` and `/tmp/hivec-document-list-polish/specs/008-document-list-polish/plan.md`
- [x] T002 [P] Align contract deltas in `/tmp/hivec-document-list-polish/specs/008-document-list-polish/contracts/document-list-polish.openapi.yaml` with backend route changes in `/tmp/hivec-document-list-polish/backend/openapi.yaml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish deletion seams with backend TDD before user-story delivery

**⚠️ CRITICAL**: No user story work begins until this phase is complete

- [x] T003 Write failing delete contract tests in `/tmp/hivec-document-list-polish/backend/tests/contract/document.contract.test.ts`
- [x] T004 Write failing deletion unit tests in `/tmp/hivec-document-list-polish/backend/tests/unit/document-deletion.test.ts`
- [x] T005 Write failing persistence integration deletion tests in `/tmp/hivec-document-list-polish/backend/tests/integration/persistence.integration.test.ts`
- [x] T006 [P] Add deletion repository port methods in `/tmp/hivec-document-list-polish/backend/src/modules/documents/services/documentIngestionService.ts` and `/tmp/hivec-document-list-polish/backend/src/db/repositories/documentRepository.ts`
- [x] T007 [P] Create and wire `/tmp/hivec-document-list-polish/backend/src/modules/documents/services/documentDeletionService.ts` in `/tmp/hivec-document-list-polish/backend/src/app/server/{types.ts,dependencies.ts}` and `/tmp/hivec-document-list-polish/backend/tests/support/{fakes.ts,testApp.ts}`
- [x] T008 Add `DELETE /api/v1/document/:documentId` transport wiring in `/tmp/hivec-document-list-polish/backend/src/app/http/routes/documentRoutes.ts`

**Checkpoint**: Backend deletion capability exists behind a dedicated orchestration seam and passes tests

---

## Phase 3: User Story 1 - Manage Documents Without Layout Breakage (Priority: P1) 🎯 MVP

**Goal**: Render document rows without horizontal overflow and show one status label + icon per row

**Independent Test**: Open documents list with long and short titles and verify row readability without horizontal scroll and without duplicate statuses

### Implementation for User Story 1

- [x] T009 [US1] Extract one-status display mapping into `/tmp/hivec-document-list-polish/frontend/components/dashboard/document-status.tsx`
- [x] T010 [US1] Rework document row layout for long-title wrapping and viewport safety in `/tmp/hivec-document-list-polish/frontend/components/dashboard/documents-view.tsx`
- [x] T011 [US1] Remove duplicate status text treatment and render only the extracted status component in `/tmp/hivec-document-list-polish/frontend/components/dashboard/documents-view.tsx`

**Checkpoint**: User Story 1 is independently functional and visually stable

---

## Phase 4: User Story 2 - Remove Obsolete Documents (Priority: P2)

**Goal**: Let users delete a document from the row with explicit confirmation and safe failure handling

**Independent Test**: Confirmed deletion removes and persists absence; cancel keeps document; failed deletion keeps row and shows error

### Tests for User Story 2 (REQUIRED for backend)

- [x] T012 [P] [US2] Extend delete ownership/not-found contract assertions in `/tmp/hivec-document-list-polish/backend/tests/contract/document.contract.test.ts`
- [x] T013 [P] [US2] Extend deletion unit coverage for audit + missing document behavior in `/tmp/hivec-document-list-polish/backend/tests/unit/document-deletion.test.ts`
- [x] T014 [P] [US2] Extend integration coverage for cross-account deletion safety in `/tmp/hivec-document-list-polish/backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 2

- [x] T015 [US2] Add delete endpoint documentation in `/tmp/hivec-document-list-polish/backend/openapi.yaml`
- [x] T016 [US2] Add `documentsApi.deleteDocument` adapter in `/tmp/hivec-document-list-polish/frontend/lib/api.ts`
- [x] T017 [US2] Add row-level delete control + confirmation flow in `/tmp/hivec-document-list-polish/frontend/components/dashboard/documents-view.tsx`
- [x] T018 [US2] Handle deletion pending/success/failure list-state updates, including last-item page recovery, in `/tmp/hivec-document-list-polish/frontend/components/dashboard/documents-view.tsx`

**Checkpoint**: User Stories 1 and 2 are independently functional

---

## Phase 5: User Story 3 - Open Citations Safely After Source Removal (Priority: P3)

**Goal**: Show a clear unavailable-source outcome when cited documents are deleted and keep chat context intact

**Independent Test**: Click a citation to a deleted source and see unavailable feedback without losing answer context; existing citations still open normally

### Implementation for User Story 3

- [x] T019 [US3] Add citation activation result handling and unavailable-source UI state in `/tmp/hivec-document-list-polish/frontend/components/dashboard/chat-citations.tsx`
- [x] T020 [US3] Add citation preflight open handler using document fetch checks in `/tmp/hivec-document-list-polish/frontend/components/dashboard/chat-view.tsx`
- [x] T021 [US3] Extend shared callback typing for async citation opening in `/tmp/hivec-document-list-polish/frontend/components/dashboard/{chat-view.tsx,dashboard-shell.tsx}`

**Checkpoint**: All user stories are independently functional

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final documentation and validation

- [x] T022 [P] Keep feature artifact contract in sync at `/tmp/hivec-document-list-polish/specs/008-document-list-polish/contracts/document-list-polish.openapi.yaml`
- [x] T023 Run backend validation suite in `/tmp/hivec-document-list-polish/backend/` (`npm test -- document.contract.test.ts document-deletion.test.ts persistence.integration.test.ts`)
- [x] T024 Run frontend validation in `/tmp/hivec-document-list-polish/frontend/` (`npm run lint`)
- [ ] T025 Execute quickstart acceptance checks in `/tmp/hivec-document-list-polish/specs/008-document-list-polish/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all story work
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on Foundational completion and builds on backend delete seam
- **User Story 3 (Phase 5)**: Depends on Foundational completion; independent of deletion internals except source-missing behavior
- **Polish (Phase 6)**: Depends on all completed story work

### User Story Dependencies

- **US1**: Independent after Foundational phase
- **US2**: Uses Foundational delete seam; independent testable behavior in documents view
- **US3**: Uses existing get-document route behavior; independent testable chat citation behavior

### Within Each User Story

- Backend tests must be written and fail before backend implementation
- Transport files remain delegation-only
- New domain behavior is added in focused modules before orchestration wiring
- Story completion and independent checks occur before moving to next priority

### Parallel Opportunities

- T006 and T007 can proceed in parallel after test tasks are authored
- T012, T013, and T014 can run in parallel
- T022 can run in parallel with final validation runs

---

## Parallel Example: User Story 2

```bash
Task: "Extend delete ownership/not-found contract assertions in /tmp/hivec-document-list-polish/backend/tests/contract/document.contract.test.ts"
Task: "Extend deletion unit coverage for audit + missing document behavior in /tmp/hivec-document-list-polish/backend/tests/unit/document-deletion.test.ts"
Task: "Extend integration coverage for cross-account deletion safety in /tmp/hivec-document-list-polish/backend/tests/integration/persistence.integration.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup + Foundational phases
2. Deliver User Story 1 list polish
3. Validate no overflow and single-status rendering

### Incremental Delivery

1. Add backend delete seam with TDD
2. Add row delete UX and failure handling
3. Add citation unavailable feedback
4. Run full validation and quickstart checks

### Parallel Team Strategy

1. One engineer handles backend deletion seam and tests
2. One engineer handles document row polish + delete UI
3. One engineer handles chat citation fallback flow

## Notes

- Total tasks: 25
- User story task counts: US1 = 3, US2 = 7, US3 = 3
- Suggested MVP scope: Phase 3 (US1) after Foundational
- All tasks include IDs, labels, and file paths per required checklist format
