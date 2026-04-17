# Tasks: Website Embed Widget

**Input**: Design documents from `/specs/040-website-embed-widget/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, quickstart.md

**Tests**: Add focused tests before implementation for any backend or shared helper changes. Frontend/runtime behavior should be covered with targeted unit tests where practical.

**Organization**: Tasks are grouped by the approved narrowed scope so the delivery remains traceable to User Story 5 without reopening the broader website-embed rollout.

## Phase 1: Setup

**Purpose**: Refresh delivery artifacts to the approved delta and identify the exact ownership seams.

- [x] T001 Refresh `specs/040-website-embed-widget/plan.md` to the approved script-level override scope
- [x] T002 Refresh `specs/040-website-embed-widget/tasks.md` so execution matches the narrowed scope and existing seams

---

## Phase 2: Foundational

**Purpose**: Add focused failing coverage for the new override behavior before implementation.

**⚠️ CRITICAL**: No implementation work begins until the relevant tests are in place.

- [x] T003 [P] Add failing snippet-helper coverage for locale, initial-state, and avatar attributes in `frontend/tests/unit/embed-widget.test.ts`
- [x] T004 [P] Add failing embedded-chat bootstrap coverage for request-scoped locale overrides in `frontend/tests/unit/anonymous-chat-context.test.ts`
- [x] T005 [P] Add failing loader-script/runtime coverage for initial open state and custom collapsed avatar fallback in `frontend/tests/unit/radioso-embed-script.test.ts`

**Checkpoint**: The new override behavior is specified in tests before runtime code changes land.

---

## Phase 3: User Story 5 - Tune Widget Launch Behavior In The Install Snippet (Priority: P2)

**Goal**: Let install snippets opt into locale, initial state, and collapsed-avatar overrides without adding new persisted workspace settings.

**Independent Test**: Install the widget with supported script attributes, load the page, and confirm widget copy, initial open/collapsed state, bootstrap locale hint, and collapsed avatar behavior all match the snippet while invalid values fall back safely.

### Implementation for User Story 5

- [x] T006 [US5] Extend snippet attribute helpers in `frontend/lib/embed-widget.ts`
- [x] T007 [US5] Propagate the embed locale override through `frontend/lib/anonymous-chat-context.tsx` and the hosted embed surface under `frontend/components/chat/embedded-chat-frame.tsx`
- [x] T008 [US5] Implement script-level locale, initial state, and collapsed-avatar behavior with safe fallback in `frontend/public/radioso-embed.js`
- [x] T009 [US5] Document the optional snippet attributes where operators copy website-embed settings in `frontend/components/dashboard/settings/general-tab.tsx`
- [ ] T010 [US5] Keep backend-generated default snippet behavior aligned, without new persisted settings, in `backend/src/app/http/routes/settingsRoutes.ts`
- [x] T011 [US5] Add a consistent new-chat reset action to authenticated, anonymous, and embedded chat surfaces

**Checkpoint**: The widget supports the approved script-level overrides end-to-end while preserving the existing trust boundary and persistence model.

---

## Phase 4: Polish & Validation

**Purpose**: Verify the scoped implementation, update task state, and capture residual risks.

- [x] T012 [P] Run focused frontend tests covering snippet helpers, anonymous bootstrap, and loader runtime behavior
- [ ] T013 [P] Run any targeted backend validation needed for snippet generation parity
- [ ] T014 Validate the narrowed quickstart scenarios in `specs/040-website-embed-widget/quickstart.md` for locale override, initial state, avatar fallback behavior, and new-chat reset behavior
- [x] T015 Mark completed tasks and summarize remaining risks in `specs/040-website-embed-widget/tasks.md`

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks implementation
- **User Story 5 (Phase 3)**: Depends on Foundational completion
- **Polish (Phase 4)**: Depends on Phase 3

### Within This Scope

- Tests for shared helpers and runtime behavior must land before implementation
- No new persisted settings should be introduced unless implementation proves strictly necessary
- Existing website-embed/public-chat/settings seams remain the only ownership boundaries for this work

## Implementation Strategy

### Delivery Order

1. Lock the narrowed plan/tasks to the approved scope
2. Add failing focused tests
3. Implement helper and runtime support for locale, open state, and avatar overrides
4. Add the shared new-chat reset affordance
5. Validate and document operator-facing usage

## Notes

- The copied install snippet remains the default baseline; optional overrides are script attributes, not workspace settings.
- Unsupported locale, initial-state, and avatar values must fail safely and preserve current behavior.
- The new-chat action clears local active-thread state and session continuity where appropriate; it does not delete persisted history records.
