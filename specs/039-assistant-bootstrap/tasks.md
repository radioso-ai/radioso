# Tasks: Assistant Bootstrap

**Input**: Design documents from `/specs/039-assistant-bootstrap/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and appear before implementation tasks. Frontend verification follows the scenarios in `quickstart.md`.

**Organization**: Tasks are grouped by user story so each story remains independently testable.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh Speckit artifacts and planning context for implementation.

- [X] T001 Refresh planning artifacts in `specs/039-assistant-bootstrap/plan.md`, `specs/039-assistant-bootstrap/research.md`, `specs/039-assistant-bootstrap/data-model.md`, `specs/039-assistant-bootstrap/contracts/chat-bootstrap-contract.md`, and `specs/039-assistant-bootstrap/quickstart.md`
- [X] T002 Update agent context via `.specify/scripts/bash/update-agent-context.sh`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the shared persistence, domain, and startup seams required by all stories.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 Add additive workspace assistant bootstrap migration in `backend/src/db/migrations/039_assistant_bootstrap.sql`
- [X] T004 [P] Add assistant bootstrap settings types and validation in `backend/src/modules/settings/domain/assistantBootstrapSettings.ts`
- [X] T005 [P] Extend workspace repository persistence and record mapping in `backend/src/db/repositories/workspaceRepository.ts`
- [X] T006 [P] Add locale validation helper for chat startup in `backend/src/modules/chat/services/chatLocale.ts`
- [X] T007 Create focused bootstrap orchestration service in `backend/src/modules/chat/services/chatBootstrapService.ts`
- [X] T008 Wire bootstrap service and repository dependencies in `backend/src/app/server/dependencies.ts` and `backend/src/app/server/types.ts`

**Checkpoint**: Shared workspace/bootstrap seams are ready for story work.

---

## Phase 3: User Story 1 - Configure Assistant Identity (Priority: P1) 🎯 MVP

**Goal**: Let operators configure workspace-scoped assistant bootstrap settings from General Settings.

**Independent Test**: Save assistant bootstrap fields in General Settings, reload them, and confirm another workspace keeps different values.

### Tests for User Story 1 (REQUIRED for backend)

- [X] T009 [P] [US1] Extend general settings contract coverage in `backend/tests/contract/general-settings.contract.test.ts`
- [X] T010 [P] [US1] Add settings service/repository coverage for assistant bootstrap defaults and normalization in `backend/tests/unit/settings-services.test.ts` and `backend/tests/support/fakes.ts`

### Implementation for User Story 1

- [X] T011 [US1] Extend general settings route schemas and responses in `backend/src/app/http/routes/settingsRoutes.ts`
- [X] T012 [US1] Update code-first OpenAPI registry for general settings in `backend/src/app/http/openapi/document.ts`
- [X] T013 [US1] Extend frontend general settings API types/methods in `frontend/lib/api.ts`
- [X] T014 [US1] Add Assistant Identity controls to `frontend/components/dashboard/settings/general-tab.tsx`
- [X] T015 [US1] Regenerate generated OpenAPI artifacts in `backend/openapi.yaml` and `backend/openapi.json`

**Checkpoint**: Operators can configure and reload assistant bootstrap settings independently of chat startup behavior.

---

## Phase 4: User Story 2 - Start New Chats With the Right Greeting and Language (Priority: P1)

**Goal**: Brand-new authenticated conversations can create an assistant-first greeting using workspace persona plus request-scoped locale.

**Independent Test**: Start a fresh authenticated chat with `userExpectedLocale`, verify the greeting appears before user input, then reopen the conversation and confirm no duplicate greeting is added.

### Tests for User Story 2 (REQUIRED for backend)

- [X] T016 [P] [US2] Extend authenticated chat contract coverage for bootstrap greeting and locale hints in `backend/tests/contract/chat.contract.test.ts`
- [X] T017 [P] [US2] Add unit coverage for bootstrap orchestration and locale fallback in `backend/tests/unit/chat-bootstrap-service.test.ts`
- [X] T018 [P] [US2] Add integration coverage for new-conversation greeting persistence in `backend/tests/integration/chat-bootstrap.integration.test.ts`

### Implementation for User Story 2

- [X] T019 [US2] Extend authenticated chat request validation and routing in `backend/src/app/http/routes/chatRoutes.ts`
- [X] T020 [US2] Add authenticated chat bootstrap orchestration and response handling in `backend/src/modules/chat/services/chatBootstrapService.ts` and related chat service modules
- [X] T021 [US2] Update chat history/domain handling for assistant-first conversations in `backend/src/modules/chat/services/chatHistoryService.ts` and supporting repositories if needed
- [X] T022 [US2] Extend frontend authenticated chat client and context startup flow in `frontend/lib/api.ts` and `frontend/lib/chat-context.tsx`
- [X] T023 [US2] Update authenticated chat surface behavior in `frontend/components/dashboard/chat-view.tsx`
- [X] T024 [US2] Regenerate generated OpenAPI artifacts in `backend/openapi.yaml` and `backend/openapi.json`

**Checkpoint**: Authenticated new chat startup works end-to-end with assistant-first greeting and request locale.

---

## Phase 5: User Story 3 - Preserve Future Embed and Popup Flexibility (Priority: P2)

**Goal**: Public chat uses the same persona/bootstrap rules while allowing a different request locale per fresh conversation.

**Independent Test**: Start one authenticated chat in one locale and one public chat in another for the same workspace; verify persona is stable but greeting locale follows the request.

### Tests for User Story 3 (REQUIRED for backend)

- [X] T025 [P] [US3] Extend public chat contract coverage for bootstrap greeting and locale hints in `backend/tests/contract/public-chat.contract.test.ts`
- [X] T026 [P] [US3] Add integration coverage for public chat bootstrap startup in `backend/tests/integration/anonymous-chat.integration.test.ts`

### Implementation for User Story 3

- [X] T027 [US3] Extend public chat request validation and routing in `backend/src/app/http/routes/publicChatRoutes.ts`
- [X] T028 [US3] Wire public bootstrap startup through shared bootstrap orchestration in `backend/src/modules/chat/services/chatBootstrapService.ts`
- [X] T029 [US3] Extend public chat API/context startup flow in `frontend/lib/api.ts` and `frontend/lib/anonymous-chat-context.tsx`
- [X] T030 [US3] Update public chat page empty-state/startup behavior in `frontend/app/chat/[token]/page.tsx`
- [X] T031 [US3] Regenerate generated OpenAPI artifacts in `backend/openapi.yaml` and `backend/openapi.json`

**Checkpoint**: Public chat preserves the same workspace persona and honors request-level locale on fresh startup.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, docs, artifact sync, and review readiness.

- [X] T032 [P] Update user-facing documentation in `readme.md` and any affected frontend settings docs under `frontend/docs/settings-docs/`
- [X] T033 [P] Add or extend audit/diagnostic visibility for bootstrap outcomes in backend chat/settings modules
- [X] T034 Run targeted backend validation for settings, chat, and public chat in `backend/tests/`
- [X] T035 Run targeted frontend/type validation in `frontend/` and any required repo scripts
- [X] T036 Mark completed tasks and verify `specs/039-assistant-bootstrap/quickstart.md` scenarios against the final implementation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately.
- **Foundational (Phase 2)**: Depends on Setup and blocks all story work.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Depends on Foundational and benefits from US1 contract/persistence work.
- **User Story 3 (Phase 5)**: Depends on Foundational and shared bootstrap orchestration from US2.
- **Polish (Phase 6)**: Depends on desired user stories being complete.

### User Story Dependencies

- **US1**: Independent after Foundational.
- **US2**: Depends on shared bootstrap seam and the settings payload added in US1.
- **US3**: Depends on shared bootstrap seam and locale-aware startup behavior proved in US2.

### Within Each User Story

- Backend tests must be written and fail before implementation.
- OpenAPI registry updates precede generated artifact refresh.
- Focused service extractions happen before route wiring.
- Frontend startup behavior lands after backend contracts are in place.

### Parallel Opportunities

- T004, T005, and T006 can run in parallel after the migration shape is clear.
- Contract and unit tests inside each story can run in parallel.
- Frontend API type updates can run in parallel with route/OpenAPI work once the contract is settled.

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases.
2. Deliver US1 so operators can configure assistant bootstrap.
3. Deliver US2 so authenticated new chat startup works end-to-end.
4. Validate those flows before extending public chat.

### Incremental Delivery

1. Assistant bootstrap settings round-trip in General Settings.
2. Authenticated chat gains assistant-first startup with `userExpectedLocale`.
3. Public chat adopts the same behavior.
4. Finish docs, validation, and review readiness.
