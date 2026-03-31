# Tasks: Persistent Dashboard Links

**Input**: Design documents from `/specs/033-dashboard-deep-links/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Frontend route-state coverage plus validation with lint and production build.

**Organization**: Tasks are grouped by user story to preserve traceability to the approved spec.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the implementation artifacts and identify the canonical routing seam.

- [x] T001 Refresh feature documentation in `specs/033-dashboard-deep-links/plan.md`, `specs/033-dashboard-deep-links/research.md`, `specs/033-dashboard-deep-links/data-model.md`, and `specs/033-dashboard-deep-links/quickstart.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the shared dashboard route-state contract used by all supported views.

- [x] T002 Create the normalized dashboard route-state contract in `frontend/lib/dashboard-routes.ts`
- [x] T003 Wire the account dashboard route entry to the shared route parser in `frontend/app/account/[accountId]/[[...segments]]/page.tsx`
- [x] T004 Wire workspace restoration and canonical route normalization in `frontend/components/dashboard/dashboard-shell.tsx`
- [x] T005 [P] Add route-state unit coverage in `frontend/tests/unit/dashboard-routes.test.ts`

**Checkpoint**: Shared route-state handling is available for section-level integration.

---

## Phase 3: User Story 1 - Reopen the exact dashboard location (Priority: P1) 🎯 MVP

**Goal**: Restore the same workspace, section, and supported in-section location after refresh or revisit.

**Independent Test**: Copy a supported dashboard URL, reopen it, and verify the same workspace and section context load.

- [x] T006 [US1] Preserve workspace-aware sidebar navigation in `frontend/components/dashboard/app-sidebar.tsx`
- [x] T007 [US1] Preserve workspace-aware dashboard CTAs in `frontend/components/dashboard/chat-view.tsx` and `frontend/components/dashboard/first-run-experience.tsx`

**Checkpoint**: The dashboard can reopen the same workspace and section without falling back to a generic location.

---

## Phase 4: User Story 2 - Navigate long collections and detail drawers with stable links (Priority: P1)

**Goal**: Make Documents and History pagination plus detail selection revisit-able through the URL.

**Independent Test**: Open a non-default documents or history page, open a detail view, refresh, and verify the same state reopens.

- [x] T008 [US2] Bind document page and selected document state to the route in `frontend/components/dashboard/documents-view.tsx`
- [x] T009 [US2] Replace client-only documents pagination links with real hrefs in `frontend/components/dashboard/documents/document-list.tsx`
- [x] T010 [US2] Bind history filter, page, and selected detail state to the route in `frontend/components/dashboard/chat-history-view.tsx`
- [x] T011 [US2] Preserve workspace-aware history CTA navigation in `frontend/components/dashboard/history/history-list.tsx`

**Checkpoint**: Documents and History reopen on the same page and selected detail state.

---

## Phase 5: User Story 3 - Link directly to settings tabs and targeted settings sections (Priority: P2)

**Goal**: Make supported settings tabs, anchors, and connector selection directly linkable.

**Independent Test**: Open a settings tab, scroll to a supported section, select a connector, refresh, and verify the same location reopens.

- [x] T012 [US3] Bind settings tab and anchor state to the route in `frontend/components/dashboard/settings-view.tsx`
- [x] T013 [US3] Add stable supported settings anchors in `frontend/components/dashboard/settings/settings-card.tsx`, `frontend/components/dashboard/settings/general-tab.tsx`, `frontend/components/dashboard/settings/ingestion-settings-panel.tsx`, and `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
- [x] T014 [US3] Bind selected connector state to the route in `frontend/components/dashboard/connectors/connectors-tab.tsx`

**Checkpoint**: Settings tabs, supported anchors, and connector selection reopen directly from the URL.

---

## Phase 6: User Story 4 - Fail safely when a link is stale or incompatible (Priority: P3)

**Goal**: Normalize invalid or stale route state into a safe usable dashboard location.

**Independent Test**: Open invalid pages, tabs, anchors, or item ids and verify the dashboard falls back without breaking.

- [x] T015 [US4] Normalize invalid route inputs in `frontend/lib/dashboard-routes.ts`
- [x] T016 [US4] Clear invalid selected item and anchor state safely in `frontend/components/dashboard/chat-history-view.tsx` and `frontend/components/dashboard/settings-view.tsx`
- [x] T017 [US4] Normalize out-of-range list pages in `frontend/components/dashboard/documents-view.tsx` and `frontend/components/dashboard/chat-history-view.tsx`

**Checkpoint**: Stale or malformed deep links fall back safely instead of trapping the dashboard in a broken state.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Validate, document, and verify the finished feature.

- [x] T018 [P] Run frontend unit tests with `npm test` in `frontend/`
- [x] T019 [P] Run frontend lint with `npm run lint` in `frontend/`
- [x] T020 [P] Run frontend production build with `npm run build` in `frontend/`

---

## Dependencies & Execution Order

- Phase 1 precedes all implementation.
- Phase 2 establishes the shared route-state seam and blocks all story integration work.
- User Story 1 depends on Phase 2.
- User Story 2 depends on Phase 2 and can build after User Story 1 or in parallel once the route-state seam exists.
- User Story 3 depends on Phase 2.
- User Story 4 depends on the supported route surfaces being in place.
- Polish depends on all requested user stories being complete.

## Implementation Strategy

1. Create the shared dashboard route-state contract.
2. Bind the dashboard shell to workspace-aware route restoration.
3. Add deep-link support to Documents and History.
4. Add deep-link support to Settings and Connectors.
5. Harden fallback behavior for stale or invalid state.
6. Validate with unit tests, lint, and production build.
