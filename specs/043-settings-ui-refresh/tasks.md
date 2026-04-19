# Tasks: Settings UI Refresh

**Input**: Design documents from `/specs/043-settings-ui-refresh/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Frontend verification is required for the new settings metadata and anchor behavior. No backend work is planned.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Architecture**: Keep `settings-view.tsx` as the tab router/composer, move shared settings IA structure into focused helpers under `frontend/components/dashboard/settings/`, and keep persistence logic inside the existing panel files.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the feature seams before any visual refresh lands

- [X] T001 Create settings tab metadata and shell placeholders in `frontend/components/dashboard/settings/settings-tab-metadata.ts` and `frontend/components/dashboard/settings/settings-tab-shell.tsx`
- [X] T002 [P] Add frontend unit coverage scaffold for settings tab metadata in `frontend/tests/unit/settings-tab-metadata.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Land the shared navigation and anchor handling primitives used by all settings tabs

**⚠️ CRITICAL**: No user story work should begin until this phase is complete

- [X] T003 Implement shared settings tab descriptors and section lookup helpers in `frontend/components/dashboard/settings/settings-tab-metadata.ts`
- [X] T004 Implement shared tab shell, local section index, and sticky action shell in `frontend/components/dashboard/settings/settings-tab-shell.tsx`
- [X] T005 Update `frontend/components/dashboard/settings-view.tsx` to use the shared metadata for the active tab header and route anchor behavior
- [X] T006 [P] Add unit coverage for metadata lookups and anchor expectations in `frontend/tests/unit/settings-tab-metadata.test.ts`

**Checkpoint**: Shared settings navigation infrastructure is ready for the panel refreshes.

---

## Phase 3: User Story 1 - Navigate settings by job to be done (Priority: P1) 🎯 MVP

**Goal**: Make settings orientation and section-level navigation obvious inside each tab

**Independent Test**: Open each tab, confirm it shows a tab summary and local section index, and navigate to a section by anchor without losing context.

- [X] T007 [US1] Integrate the shared tab shell into `frontend/components/dashboard/settings/general-tab.tsx`
- [X] T008 [US1] Integrate the shared tab shell into `frontend/components/dashboard/settings/ingestion-settings-panel.tsx`
- [X] T009 [US1] Integrate the shared tab shell into `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
- [X] T010 [US1] Ensure all existing settings section ids line up with the new tab metadata anchors across `frontend/components/dashboard/settings/general-tab.tsx`, `frontend/components/dashboard/settings/ingestion-settings-panel.tsx`, and `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`

**Checkpoint**: Each settings tab exposes consistent section navigation and overview chrome.

---

## Phase 4: User Story 2 - Tune retrieval and ingestion without decoding the implementation (Priority: P2)

**Goal**: Make the high-complexity tabs easier to scan and save

**Independent Test**: Open Ingestion and Retrieval, confirm controls are grouped into distinct outcome-oriented sections, and verify save actions remain accessible while scrolling.

- [X] T011 [US2] Refresh the ingestion layout and section grouping in `frontend/components/dashboard/settings/ingestion-settings-panel.tsx`
- [X] T012 [US2] Refresh the retrieval layout and section grouping in `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`
- [X] T013 [US2] Enhance shared settings card and action styling in `frontend/components/dashboard/settings/settings-card.tsx` and `frontend/components/dashboard/settings/settings-tab-shell.tsx`

**Checkpoint**: Ingestion and Retrieval are scannable, grouped, and easier to operate during long edits.

---

## Phase 5: User Story 3 - Manage general settings in coherent groups (Priority: P3)

**Goal**: Make the General tab read like a structured control center instead of a settings dump

**Independent Test**: Open General settings and confirm workspace/access, assistant setup, anonymous chat, and website embed appear as clear sections with consistent structure.

- [X] T014 [US3] Reorganize the general settings layout and card hierarchy in `frontend/components/dashboard/settings/general-tab.tsx`
- [X] T015 [US3] Align any supporting section text and shared treatment in `frontend/components/dashboard/settings/settings-card.tsx`

**Checkpoint**: General settings are grouped coherently and remain functionally unchanged.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finish verification and documentation for the redesigned settings experience

- [X] T016 [P] Update operator-facing settings organization notes in `frontend/docs/settings-docs/README.md`
- [X] T017 Run targeted frontend tests in `frontend/tests/unit/settings-tab-metadata.test.ts`
- [X] T018 Run the `specs/043-settings-ui-refresh/quickstart.md` validation flow and capture residual risks in `specs/043-settings-ui-refresh/tasks.md`
- [X] T019 Mark completed tasks and residual notes in `specs/043-settings-ui-refresh/tasks.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup
- **User Story 1 (Phase 3)**: Depends on Foundational
- **User Story 2 (Phase 4)**: Depends on User Story 1
- **User Story 3 (Phase 5)**: Depends on User Story 1
- **Polish (Phase 6)**: Depends on the implemented user stories

### User Story Dependencies

- **US1** establishes the shared shell and navigation integration used by the rest of the redesign.
- **US2** depends on the shared shell to avoid duplicating layout primitives in retrieval and ingestion.
- **US3** depends on the shared shell but is otherwise independent of the retrieval/ingestion refinements.

### Parallel Opportunities

- T002 and T006 can be developed independently from the main layout work.
- T011 and T014 touch different panel files and can proceed separately after the shared shell lands.

## Implementation Strategy

### MVP First

1. Land the metadata + shared shell.
2. Use it to make section navigation real across all tabs.
3. Refine the high-complexity tabs.
4. Finish by restructuring General and updating docs/tests.

## Residual Risks

- Manual authenticated browser QA from `quickstart.md` was not run in this workspace because the local app was not started and logged in during this pass.
- `frontend/node_modules/` was installed locally to run verification in this workspace; that directory remains untracked and may be removed if you prefer a clean workspace after review.
