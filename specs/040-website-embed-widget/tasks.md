# Tasks: Website Embed Widget

**Input**: Design documents from `/specs/040-website-embed-widget/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before implementation tasks. Frontend tests cover launcher and settings behavior where practical.

**Organization**: Tasks are grouped by user story so each slice stays independently testable and traceable to the approved spec.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the planning-aligned workspace and documentation surfaces.

- [x] T001 Refresh operator-facing settings docs index references for the new website-embed section in `frontend/docs/settings-docs/README.md`
- [x] T002 Identify the website-embed migration number and scaffold the additive workspace-column migration in `backend/src/db/migrations/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the minimum shared persistence and contract foundation required before any user story can land.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Add failing repository/unit coverage for website-embed workspace settings mapping and validation in `backend/tests/unit/`
- [x] T004 Add failing contract coverage for website-embed fields on `GET/PUT /api/v1/settings/general` in `backend/tests/contract/general-settings.contract.test.ts`
- [x] T005 Add additive workspace columns for website-embed settings in a new migration under `backend/src/db/migrations/`
- [x] T006 Update `backend/src/db/repositories/workspaceRepository.ts` to read/write website-embed settings with minimal API-surface change
- [x] T007 Extend `backend/src/app/http/openapi/document.ts` for website-embed settings fields and regenerate `backend/openapi.yaml` plus `backend/openapi.json`

**Checkpoint**: Workspace persistence and settings contract are ready for user-story work.

---

## Phase 3: User Story 1 - Install The Assistant On A Website (Priority: P1) 🎯 MVP

**Goal**: Let operators enable website embed, configure approved origins/basic launcher settings, and copy a one-line install snippet.

**Independent Test**: Enable website embed in General Settings, configure an approved origin and launcher label, and verify the snippet and settings round-trip correctly.

### Tests for User Story 1

- [x] T008 [P] [US1] Add backend contract coverage for enabling website embed and returning snippet/origin fields in `backend/tests/contract/general-settings.contract.test.ts`
- [ ] T009 [P] [US1] Add backend integration coverage for embed settings audit events in `backend/tests/integration/`
- [ ] T010 [P] [US1] Add frontend unit coverage for General Settings website-embed controls in `frontend/tests/unit/`

### Implementation for User Story 1

- [x] T011 [US1] Extend `backend/src/app/http/routes/settingsRoutes.ts` schema and response shaping for website-embed settings
- [x] T012 [US1] Add website-embed settings validation helpers in `backend/src/modules/settings/domain/`
- [x] T013 [US1] Extend `frontend/lib/api.ts` general-settings types and requests for website embed
- [x] T014 [US1] Add a website-embed settings section to `frontend/components/dashboard/settings/general-tab.tsx`
- [x] T015 [US1] Add settings docs entries for website-embed fields under `frontend/docs/settings-docs/general/`
- [x] T016 [US1] Update `readme.md` with the operator install flow and snippet expectations

**Checkpoint**: Operators can configure website embed and copy an install snippet without any visitor-side runtime yet.

---

## Phase 4: User Story 2 - Visitor Chats Inside The Embedded Assistant (Priority: P1)

**Goal**: Let approved sites open a hosted iframe assistant that reuses public-chat behavior and assistant bootstrap.

**Independent Test**: Load the launcher on an approved site, open the iframe assistant, send a message, and verify conversation continuity on refresh.

### Tests for User Story 2

- [x] T017 [P] [US2] Add failing backend contract coverage for embed session bootstrap in `backend/tests/contract/`
- [ ] T018 [P] [US2] Add failing backend integration coverage for approved-origin embed launches in `backend/tests/integration/`
- [ ] T019 [P] [US2] Add frontend unit coverage for the hosted embed page/launcher lifecycle in `frontend/tests/unit/`

### Implementation for User Story 2

- [x] T020 [US2] Add a focused embed session/access helper plus any sibling middleware needed under `backend/src/app/http/middleware/` or `backend/src/modules/`
- [x] T021 [US2] Add the public embed session bootstrap route alongside existing public-chat transport in `backend/src/app/http/routes/`
- [x] T022 [US2] Wire the new embed route in `backend/src/app/http/routes/index.ts`
- [x] T023 [US2] Add hosted iframe entry route in `frontend/app/embed/[token]/`
- [x] T024 [US2] Reuse or lightly extend `frontend/lib/anonymous-chat-context.tsx` for embedded startup without forking chat behavior
- [x] T025 [US2] Add the thin installer script entry point in the frontend static/app layer and generate the corresponding script URL/snippet from settings

**Checkpoint**: Approved sites can load the launcher and use the embedded assistant end-to-end.

---

## Phase 5: User Story 3 - Reject Unapproved Or Unsafe Embeds (Priority: P1)

**Goal**: Enforce allowed-origin policy and deny unsafe launches without exposing reusable credentials.

**Independent Test**: Use the same snippet on approved and unapproved origins and confirm only approved origins can obtain a usable embed launch.

### Tests for User Story 3

- [x] T026 [P] [US3] Add failing backend contract coverage for denied embed launches in `backend/tests/contract/`
- [ ] T027 [P] [US3] Add failing backend integration coverage for allowlist enforcement and disablement behavior in `backend/tests/integration/`
- [ ] T028 [P] [US3] Add frontend unit coverage for blocked/unavailable launcher states in `frontend/tests/unit/`

### Implementation for User Story 3

- [x] T029 [US3] Enforce origin allowlist checks during embed session bootstrap in the focused embed-access logic
- [x] T030 [US3] Record allow/deny diagnostics through the existing audit pipeline from the embed bootstrap path
- [x] T031 [US3] Add user-friendly blocked/unavailable states to the hosted embed launcher and iframe shell
- [x] T032 [US3] Confirm public-chat rate limiting and bootstrap behavior remain at least as strict for website embed as for anonymous public chat

**Checkpoint**: Unapproved or disabled embed launches fail safely and are operator-visible.

---

## Phase 6: User Story 4 - Monitor And Operate The Embedded Channel (Priority: P2)

**Goal**: Give operators enough visibility to understand current config and why launches were accepted or rejected.

**Independent Test**: Review the settings page and audit-visible events after successful and rejected launches.

### Tests for User Story 4

- [ ] T033 [P] [US4] Add backend integration coverage for embed-related audit metadata in `backend/tests/integration/`
- [ ] T034 [P] [US4] Add frontend unit coverage for embed diagnostics/config display in `frontend/tests/unit/`

### Implementation for User Story 4

- [x] T035 [US4] Surface website-embed config and explanatory copy in `frontend/components/dashboard/settings/general-tab.tsx`
- [ ] T036 [US4] Add any minimal operator-visible diagnostics wiring needed through existing settings or audit surfaces

**Checkpoint**: Operators can inspect configuration and reason about allow/deny behavior.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Finish validation, documentation, and minimal cleanup across all stories.

- [x] T037 [P] Regenerate OpenAPI artifacts from `backend/src/app/http/openapi/document.ts`
- [ ] T038 [P] Update `.env.example` if website-embed script or public-base configuration introduces new environment requirements
- [x] T039 [P] Run backend test suites covering new contract/integration/unit behavior
- [x] T040 [P] Run frontend unit coverage relevant to website-embed settings and launcher behavior
- [ ] T041 Validate the end-to-end operator flow using `specs/040-website-embed-widget/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Stories (Phases 3-6)**: Depend on Foundational completion
- **Polish (Phase 7)**: Depends on desired user stories being complete

### User Story Dependencies

- **US1**: Starts after Foundational and is the MVP operator setup slice
- **US2**: Starts after Foundational and depends on US1’s settings/persistence work
- **US3**: Starts after US2’s bootstrap path exists
- **US4**: Starts after US1 and US3 provide config plus diagnostics inputs

### Within Each User Story

- Backend tests must fail before backend implementation
- Add focused siblings before broad abstractions
- Keep route files transport-only
- Extend existing public-chat/settings flows before creating new shared modules
- Avoid expanding connector infrastructure

### Parallel Opportunities

- T003 and T004 can be prepared in parallel
- Within each user story, backend/frontend test authoring can run in parallel
- Documentation tasks can run in parallel with later implementation once contract shapes are stable

## Implementation Strategy

### MVP First

1. Complete Foundational work
2. Deliver US1 operator setup
3. Deliver US2 hosted iframe runtime
4. Validate approved-origin launch end to end

### Incremental Delivery

1. Settings and persistence first
2. Hosted embed runtime second
3. Allowlist enforcement third
4. Operator diagnostics and polish last

## Notes

- Favor additive workspace fields over new tables.
- Favor sibling embed-specific files over generic public-access abstractions.
- Reuse the existing public chat UI/context where possible rather than forking a second assistant surface.
