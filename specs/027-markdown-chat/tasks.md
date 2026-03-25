# Tasks: Safe Markdown Chat Answers

**Input**: Design documents from `/Users/dm/conductor/workspaces/radioso/juba-markdown-chat/specs/027-markdown-chat/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Frontend rendering tests are required for the three user stories.

**Organization**: Tasks are grouped by user story so each slice can be implemented and verified independently.

**Architecture**: Keep markdown parsing and safety rules in `frontend/components/dashboard/chat-markdown.tsx`, keep citation composition in `frontend/components/dashboard/chat-citations.tsx`, and keep the live chat/history pages as thin consumers of the shared assistant renderer.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the frontend testing and rendering dependencies needed for the feature.

- [X] T001 Update `frontend/package.json` and `frontend/package-lock.json` to add `react-markdown`, `remark-breaks`, and a frontend `test` script
- [X] T002 Add Vitest configuration in `frontend/vitest.config.ts` so TSX tests resolve `@/` imports and run in a Node environment

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the shared renderer that every story will build on.

- [X] T003 Create the safe assistant markdown renderer in `frontend/components/dashboard/chat-markdown.tsx`

**Checkpoint**: The shared markdown renderer exists and the story-specific work can begin.

---

## Phase 3: User Story 1 - Read Structured Answers Clearly (Priority: P1) 🎯 MVP

**Goal**: Assistant answers render supported markdown in a readable way across chat surfaces.

**Independent Test**: Render a message containing paragraphs, emphasis, inline code, fenced code blocks, lists, and blockquotes, then confirm the output uses semantic markdown markup instead of plain text only.

### Tests for User Story 1

- [X] T004 [US1] Add render coverage in `frontend/tests/unit/chat-markdown.test.tsx` for the supported markdown subset

### Implementation for User Story 1

- [X] T005 [US1] Style `frontend/components/dashboard/chat-markdown.tsx` so paragraphs, lists, blockquotes, inline code, and fenced code blocks are legible inside assistant messages

**Checkpoint**: Supported markdown renders cleanly and is readable on its own.

---

## Phase 4: User Story 2 - Keep Citations Trustworthy (Priority: P2)

**Goal**: Citation markers remain attached to the intended assistant text when markdown is present.

**Independent Test**: Render segmented assistant content that includes markdown and citations, then confirm citation buttons still appear adjacent to the intended segment and still preserve the source-opening affordance.

### Tests for User Story 2

- [X] T006 [US2] Add citation-plus-markdown coverage in `frontend/tests/unit/chat-citations.test.tsx`

### Implementation for User Story 2

- [X] T007 [US2] Update `frontend/components/dashboard/chat-citations.tsx` to render assistant segments through the shared markdown renderer and append citation markers after each segment

**Checkpoint**: Markdown formatting and citations coexist without breaking source provenance or document-opening behavior.

---

## Phase 5: User Story 3 - Reject Unsafe Rich Content (Priority: P3)

**Goal**: Unsafe content stays inert instead of becoming active rich HTML or executable navigation.

**Independent Test**: Render raw HTML and unsafe link targets, then confirm they do not become active content and do not gain broader rendering privileges than intended.

### Tests for User Story 3

- [X] T008 [US3] Add safety coverage in `frontend/tests/unit/chat-markdown-safety.test.tsx` for raw HTML and unsafe link targets

### Implementation for User Story 3

- [X] T009 [US3] Harden `frontend/components/dashboard/chat-markdown.tsx` to keep raw HTML inert and downgrade unsafe links to non-active text

**Checkpoint**: Unsupported rich content does not become active in the chat surface.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validate the feature end-to-end across all shared chat surfaces and finalize the frontend quality gate.

- [X] T010 Validate the shared renderer path in `frontend/app/chat/[token]/page.tsx`, `frontend/components/dashboard/chat-history-view.tsx`, and `frontend/components/dashboard/chat-view.tsx`, then run `npm test` and `npm run lint` in `frontend/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - blocks all user stories
- **User Stories (Phase 3+)**: Depend on Foundational phase completion
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; establishes the renderer behavior
- **User Story 2 (P2)**: Can start after Foundational; builds on the shared renderer to preserve citations
- **User Story 3 (P3)**: Can start after Foundational; hardens the same renderer against unsafe content

### Within Each User Story

- Write the test first, confirm it fails, then implement the story
- Keep changes limited to the files named in the task
- Preserve the shared renderer seam instead of expanding the chat page or thread components
- Verify story completion before moving to the next priority

### Parallel Opportunities

- T001 and T002 can run in parallel after the dependency choice is fixed
- T004, T006, and T008 can be prepared independently once the shared renderer exists
- T005, T007, and T009 touch different concerns but should still follow their story tests

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1
4. Stop and validate the rendered markdown experience before layering citations or safety hardening

### Incremental Delivery

1. Setup + Foundational
2. User Story 1: readable markdown
3. User Story 2: citations preserved
4. User Story 3: unsafe content rejected
5. Final frontend validation across the shared chat surfaces
