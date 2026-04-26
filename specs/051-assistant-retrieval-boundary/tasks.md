# Tasks: Assistant-Retrieval Boundary

**Input**: Design documents from `/specs/051-assistant-retrieval-boundary/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and must be written before implementation for each affected slice. Frontend user-visible behavior should use Playwright coverage, while frontend unit tests stay limited to non-visual API and routing logic.

**Organization**: Tasks are grouped by user story so each contract slice can be implemented and validated independently while preserving the ownership seams declared in `plan.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (`[US1]`, `[US2]`, etc.)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Refresh the approved artifacts and confirm the current code seams before implementation begins.

- [X] T001 Reconcile the approved feature artifacts in `specs/051-assistant-retrieval-boundary/spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/assistant-retrieval-api-contract.md`, and `quickstart.md`
- [X] T002 [P] Review the current authenticated chat, public chat, history, and settings seams in `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/publicChatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/chat/services/chatBootstrapService.ts`, and `backend/src/modules/chat/services/chatHistoryService.ts`
- [X] T003 [P] Review the current retrieval and MCP seams in `backend/src/modules/retrieval/services/`, `packages/radioso-mcp-server/src/radiosoApiAdapter.ts`, `packages/radioso-mcp-server/src/tools/readTools.ts`, `frontend/lib/api.ts`, and `frontend/components/dashboard/settings/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the assistant ownership seam, prompt-asset ownership split, shared settings seam, and retrieval capability seam before any story-specific transport work starts.

**⚠️ CRITICAL**: No user story implementation starts before this phase is complete.

- [X] T004 [P] Add failing endpoint-family contract coverage in `backend/tests/contract/assistant.contract.test.ts`, `backend/tests/contract/history.contract.test.ts`, `backend/tests/contract/retrieval-search.contract.test.ts`, and `backend/tests/contract/retrieval-answer.contract.test.ts`
- [X] T005 [P] Add failing unit coverage for assistant settings aggregation and merge-safe shared settings updates in `backend/tests/unit/settings-services.test.ts`
- [X] T006 [P] Add failing unit coverage for assistant routing and retrieval unsupported outcomes in `backend/tests/unit/chat-service-streaming.test.ts` and `backend/tests/unit/chat-retrieval.domain.test.ts`
- [X] T007 Create assistant-owned domain types in `backend/src/modules/assistant/domain/assistantSettings.ts` and `backend/src/modules/assistant/types/assistantApi.ts`
- [X] T008 Create assistant-owned services in `backend/src/modules/assistant/services/assistantInstructionBuilder.ts`, `backend/src/modules/assistant/services/assistantRouteService.ts`, and `backend/src/modules/assistant/services/assistantChatService.ts`
- [X] T009 Create assistant-owned shared-resource services in `backend/src/modules/assistant/services/assistantHistoryService.ts` and `backend/src/modules/assistant/services/assistantSettingsService.ts`, and make the assistant settings seam the canonical owner of assistant identity, greeting, locale, conversation mode, suggested questions, and custom instruction assembly
- [X] T010 Create retrieval capability transports and result types in `backend/src/modules/retrieval/services/retrievalSearchService.ts`, `backend/src/modules/retrieval/services/retrievalAnswerService.ts`, and related retrieval domain types under `backend/src/modules/retrieval/domain/`
- [X] T011 Split prompt-asset ownership under `backend/prompts/` so assistant-owned `.md` instruction files live under `backend/prompts/chat/` and retrieval-owned `.md` instruction files remain under `backend/prompts/retrieval/`; move or reclassify any mixed answer-instruction assets that no longer belong to retrieval ownership
- [X] T012 Update prompt-loading callers in `backend/src/modules/retrieval/services/sharedAnswerInstructionBuilder.ts`, `backend/src/modules/retrieval/services/promptBuilder.ts`, `backend/src/modules/chat/services/nonRetrievalAnswerPromptBuilder.ts`, `backend/src/modules/chat/services/groundedMissResponseComposer.ts`, and the new assistant services so they load the assistant-vs-retrieval prompt files from the correct directories after the split
- [X] T013 Wire the new assistant and retrieval services into `backend/src/app/server/dependencies.ts` and `backend/src/app/server/types.ts`

**Checkpoint**: The codebase has dedicated assistant and retrieval service seams, plus failing contract and settings tests that block accidental route or ownership drift.

---

## Phase 3: User Story 1 - Chat Through A Dedicated Assistant Surface (Priority: P1) 🎯 MVP

**Goal**: Human-facing authenticated and public chat requests use one assistant-owned chat core, preserve conversation history, and choose direct versus retrieval-backed answers inside the assistant domain.

**Independent Test**: Send brand-new and follow-up messages through authenticated chat and public chat, then verify both surfaces normalize into the assistant domain and return either direct or retrieval-backed answers through the assistant contract.

### Tests for User Story 1

- [X] T014 [P] [US1] Add failing integration coverage for authenticated assistant direct and retrieval-backed paths in `backend/tests/integration/chat.integration.test.ts`
- [X] T015 [P] [US1] Add failing integration coverage for public-chat assistant transport behavior in `backend/tests/integration/anonymous-chat.integration.test.ts`
- [X] T016 [P] [US1] Add failing contract coverage for `POST /api/v1/assistant/chat`, `GET /api/v1/history`, and `GET /api/v1/history/:conversationId` in `backend/tests/contract/assistant.contract.test.ts` and `backend/tests/contract/history.contract.test.ts`

### Implementation for User Story 1

- [X] T017 [US1] Refactor `backend/src/app/http/routes/chatRoutes.ts` and `backend/src/app/http/routes/index.ts` so authenticated chat uses `POST /api/v1/assistant/chat` plus shared history routes instead of the legacy mixed `/api/v1/chat` contract
- [X] T018 [US1] Refactor `backend/src/app/http/routes/publicChatRoutes.ts` and `backend/src/app/http/routes/publicEmbedRoutes.ts` so anonymous/embed access control, rate limiting, origin checks, and session issuance remain transport-owned while all chat execution normalizes into `backend/src/modules/assistant/services/assistantChatService.ts`
- [X] T019 [US1] Update `backend/src/modules/chat/services/chatBootstrapService.ts` and `backend/src/modules/assistant/services/assistantChatService.ts` so new-conversation greeting behavior remains assistant-owned without a separate bootstrap endpoint
- [X] T020 [US1] Wire shared history behavior through `backend/src/modules/assistant/services/assistantHistoryService.ts` and keep `backend/src/modules/chat/services/chatHistoryService.ts` responsibility-limited to persistence-facing detail assembly
- [X] T021 [US1] Update authenticated and public chat client adapters in `frontend/lib/api.ts` to call the new assistant chat and history endpoints
- [X] T022 [US1] Update dashboard history consumers in `frontend/components/dashboard/chat-history-view.tsx` and related route helpers under `frontend/lib/` to use `/api/v1/history` and `/api/v1/history/:conversationId`

**Checkpoint**: Human-facing chat now enters the backend through one assistant-owned contract, and assistant conversation history is accessible through the shared history routes.

---

## Phase 4: User Story 2 - Use Retrieval As A Standalone Grounded Capability (Priority: P1)

**Goal**: Headless RAG and MCP capability clients can call retrieval search and retrieval answer directly, including rewrite continuity and typed unsupported results, without going through assistant chat.

**Independent Test**: Call retrieval search and retrieval answer directly with and without conversation context, verify grounded results and unsupported unions, and confirm MCP grounded answer traffic uses retrieval instead of assistant chat.

### Tests for User Story 2

- [X] T023 [P] [US2] Add failing contract coverage for `POST /api/v1/retrieval/search` and `POST /api/v1/retrieval/answer` in `backend/tests/contract/retrieval-search.contract.test.ts` and `backend/tests/contract/retrieval-answer.contract.test.ts`
- [X] T024 [P] [US2] Add failing integration coverage for retrieval-only answer, retrieval-only rewrite continuity, and typed unsupported outcomes in `backend/tests/integration/retrieval-answer.integration.test.ts`
- [X] T025 [P] [US2] Add failing MCP package coverage for grounded-answer remapping in `packages/radioso-mcp-server/tests/radiosoApiAdapter.test.ts`, `packages/radioso-mcp-server/tests/readTools.test.ts`, and `packages/radioso-mcp-server/tests/httpBackendIntegration.test.ts`

### Implementation for User Story 2

- [X] T026 [US2] Create `backend/src/app/http/routes/retrievalRoutes.ts` and mount it from `backend/src/app/http/routes/index.ts` for `POST /api/v1/retrieval/search` and `POST /api/v1/retrieval/answer`
- [X] T027 [US2] Implement evidence-oriented search orchestration in `backend/src/modules/retrieval/services/retrievalSearchService.ts` and shared retrieval presenters under `backend/src/modules/retrieval/services/`
- [X] T028 [US2] Implement grounded-answer orchestration and typed `unsupported_query_type` outcomes in `backend/src/modules/retrieval/services/retrievalAnswerService.ts`
- [X] T029 [US2] Pass optional retrieval conversation-context hints through `backend/src/modules/retrieval/services/queryRewriteService.ts`, `backend/src/modules/retrieval/services/conversationContextService.ts`, and related retrieval pipeline types without making retrieval the owner of assistant history
- [X] T030 [US2] Update `packages/radioso-mcp-server/src/radiosoApiAdapter.ts`, `packages/radioso-mcp-server/src/tools/readTools.ts`, and `packages/radioso-mcp-server/src/types.ts` so MCP grounded answers use `/api/v1/retrieval/answer` and retrieval settings read from the shared platform settings contract
- [X] T031 [US2] Update capability metadata and package-facing wording in `backend/src/app/http/routes/mcpContextRoutes.ts` and `packages/radioso-mcp-server/testing/remoteSmokeHarness.ts` so MCP stays retrieval-first by default

**Checkpoint**: Retrieval is a standalone grounded capability again, and MCP uses retrieval/platform endpoints directly instead of the assistant chat surface.

---

## Phase 5: User Story 3 - Configure Assistant And Retrieval Separately (Priority: P2)

**Goal**: Workspace operators can manage assistant, retrieval, and channel settings through one shared platform resource without accidental cross-section resets.

**Independent Test**: Read shared settings, update only assistant fields, then update only retrieval fields and verify untouched sections remain unchanged while the UI still saves correctly.

### Tests for User Story 3

- [X] T032 [P] [US3] Add failing contract coverage for `GET /api/v1/settings` and merge-safe `PUT /api/v1/settings` in `backend/tests/contract/settings.contract.test.ts` and `backend/tests/contract/general-settings.contract.test.ts`
- [X] T033 [P] [US3] Add failing unit coverage for assistant, retrieval, and channel section aggregation plus partial update semantics in `backend/tests/unit/settings-services.test.ts`
- [X] T034 [P] [US3] Add failing frontend non-visual coverage for the shared settings client and settings-tab metadata in `frontend/tests/unit/settings-tab-metadata.test.ts` and a new focused API-adapter test under `frontend/tests/unit/`

### Implementation for User Story 3

- [X] T035 [US3] Create shared settings schemas and aggregation logic in `backend/src/modules/settings/domain/platformSettings.ts` and `backend/src/modules/settings/services/platformSettingsService.ts`
- [X] T036 [US3] Refactor `backend/src/app/http/routes/settingsRoutes.ts` to expose `GET /api/v1/settings` and `PUT /api/v1/settings` with merge-safe `assistant`, `retrieval`, and `channels` sections while keeping `/api/v1/settings/ingestion` unchanged
- [X] T037 [US3] Move assistant-owned behavior fields between settings sections in `backend/src/modules/settings/domain/retrievalSettings.ts`, `backend/src/modules/settings/domain/assistantBootstrapSettings.ts`, and `backend/src/modules/assistant/domain/assistantSettings.ts`
- [X] T038 [US3] Replace `generalSettingsApi` and direct retrieval-settings writes in `frontend/lib/api.ts` with a shared platform settings client that reads and writes sectioned settings payloads
- [X] T039 [US3] Update `frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx`, `frontend/components/dashboard/settings/retrieval-settings-panel.tsx`, and `frontend/components/dashboard/settings/settings-tab-metadata.ts` to use the shared settings contract
- [X] T040 [US3] Remove external messaging connector settings presentation from `frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx` and `frontend/components/dashboard/settings/settings-tab-metadata.ts` so channel settings focus on anonymous chat and website embed only
- [X] T041 [US3] Add Playwright coverage for shared assistant/retrieval/channel settings save flows in `frontend/playwright.config.ts` and `frontend/tests/e2e/assistant-retrieval-settings.spec.ts`

**Checkpoint**: Operators configure one workspace resource with clearly separated assistant, retrieval, and channel sections, and the settings UI no longer mixes external messaging connector concerns into this feature.

---

## Phase 6: User Story 4 - Preserve Debuggability Across The Boundary (Priority: P2)

**Goal**: Engineers can tell whether a response came from assistant direct, assistant retrieval-backed, retrieval-only, or MCP capability paths, and the shared history surface stays understandable.

**Independent Test**: Exercise assistant direct, assistant retrieval-backed, retrieval-only, and MCP grounded-answer flows, then inspect stored diagnostics and shared history responses for route classification.

### Tests for User Story 4

- [X] T042 [P] [US4] Add failing unit coverage for assistant-route and retrieval-route diagnostics in `backend/tests/unit/chat-history-service.test.ts` and `backend/tests/unit/retrieval-execution-telemetry-service.test.ts`
- [X] T043 [P] [US4] Add failing integration coverage for assistant direct versus retrieval-backed diagnostics in `backend/tests/integration/chat.integration.test.ts` and retrieval-only diagnostics in `backend/tests/integration/retrieval-answer.integration.test.ts`
- [X] T044 [P] [US4] Add failing Playwright coverage for shared history navigation and debug surfaces in `frontend/tests/e2e/assistant-history.spec.ts`

### Implementation for User Story 4

- [X] T045 [US4] Record execution-surface and route-type metadata in `backend/src/modules/assistant/services/assistantChatService.ts`, `backend/src/modules/retrieval/services/retrievalAnswerService.ts`, and related audit payload types
- [X] T046 [US4] Surface assistant route diagnostics through `backend/src/modules/assistant/services/assistantHistoryService.ts` and `backend/src/modules/chat/services/chatHistoryService.ts`
- [X] T047 [US4] Update retrieval diagnostics presenters in `backend/src/modules/retrieval/services/retrievalInfoPresenter.ts`, `backend/src/modules/retrieval/services/retrievalTracePresenter.ts`, and related shared response types so assistant, retrieval, and MCP paths remain distinguishable
- [X] T048 [US4] Update `frontend/components/dashboard/chat-history-view.tsx` and related history/debug components under `frontend/components/dashboard/history/` to render the shared history routes and preserved route diagnostics

**Checkpoint**: Route selection remains observable after the assistant/retrieval split, and shared history still makes assistant conversations inspectable.

---

## Phase 7: User Story 5 - Integrate Against Explicit Assistant And Retrieval Endpoints (Priority: P2)

**Goal**: Integrators can discover the new assistant, retrieval, history, and shared settings contracts from generated API docs and updated human documentation without relying on older mixed chat routes.

**Independent Test**: Inspect the generated OpenAPI contract and the updated docs, then confirm a developer can choose the correct endpoint family without reading backend source.

### Tests for User Story 5

- [X] T049 [P] [US5] Add failing OpenAPI contract coverage for assistant, retrieval, history, and shared settings paths in `backend/tests/contract/assistant.contract.test.ts`, `backend/tests/contract/history.contract.test.ts`, `backend/tests/contract/retrieval-search.contract.test.ts`, and `backend/tests/contract/settings.contract.test.ts`
- [X] T050 [P] [US5] Add failing MCP and package-facing contract coverage for endpoint wording in `packages/radioso-mcp-server/tests/httpBackendIntegration.test.ts` and `packages/radioso-mcp-server/tests/readTools.test.ts`

### Implementation for User Story 5

- [X] T051 [US5] Register the assistant, retrieval, history, and shared settings endpoints in `backend/src/app/http/openapi/document.ts`
- [X] T052 [US5] Regenerate `backend/openapi.yaml` and `backend/openapi.json`
- [X] T053 [US5] Update `readme.md` and `docs/mcp-client-setup.md` with the explicit assistant/retrieval split and MCP retrieval-first behavior
- [X] T054 [US5] Update `docs/settings-docs/README.md`, `docs/settings-docs/retrieval/custom-instruction.md`, `frontend/docs/settings-docs/general/assistant-name.md`, `frontend/docs/settings-docs/general/assistant-role.md`, `frontend/docs/settings-docs/general/greeting-instruction.md`, `frontend/docs/settings-docs/general/assistant-default-locale.md`, `frontend/docs/settings-docs/general/proactive-greeting-enabled.md`, `frontend/docs/settings-docs/general/website-embed.md`, `frontend/docs/settings-docs/retrieval/conversation-mode.md`, `frontend/docs/settings-docs/retrieval/custom-instruction.md`, `frontend/docs/settings-docs/retrieval/suggested-questions-enabled.md`, and `frontend/docs/settings-docs/retrieval/suggested-questions-count.md` to reflect the new section ownership
- [X] T055 [US5] Update package-facing wording and examples in `packages/radioso-mcp-server/src/tools/readTools.ts` and `packages/radioso-mcp-server/testing/remoteSmokeHarness.ts` so the explicit endpoint families match the shipped contract

**Checkpoint**: The generated API contract and operator/integrator docs describe the new assistant and retrieval surfaces clearly and consistently.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, artifact reconciliation, and boundary cleanup across all stories.

- [X] T056 [P] Run the validation scenarios from `specs/051-assistant-retrieval-boundary/quickstart.md`
- [X] T057 [P] Run targeted backend validation for `backend/tests/contract/`, `backend/tests/integration/chat.integration.test.ts`, `backend/tests/integration/anonymous-chat.integration.test.ts`, `backend/tests/integration/retrieval-answer.integration.test.ts`, and `backend/tests/unit/`
- [X] T058 [P] Run targeted frontend and package validation for `frontend/tests/unit/`, `frontend/tests/e2e/assistant-retrieval-settings.spec.ts`, `frontend/tests/e2e/assistant-history.spec.ts`, and `packages/radioso-mcp-server/tests/`
- [X] T059 Reconcile task completion state and feature notes across `specs/051-assistant-retrieval-boundary/`
- [X] T060 Perform final cleanup to confirm `backend/src/app/http/routes/chatRoutes.ts`, `backend/src/app/http/routes/publicChatRoutes.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, `backend/src/modules/chat/services/chatService.ts`, and `backend/src/modules/retrieval/services/sharedAnswerInstructionBuilder.ts` remained responsibility-limited

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all story work
- **User Stories (Phases 3-7)**: Depend on Foundational completion
- **Polish (Phase 8)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational and delivers the new assistant chat and shared history surfaces
- **US2 (P1)**: Starts after Foundational and can proceed in parallel with US1 once the shared assistant/retrieval seams exist
- **US3 (P2)**: Starts after Foundational and should follow once the new endpoint families are stable enough for the settings UI to adopt
- **US4 (P2)**: Starts after Foundational and depends on assistant and retrieval routes being implemented so diagnostics can classify them
- **US5 (P2)**: Starts after Foundational and should land after the endpoint shapes are stable enough to document and publish in OpenAPI

### Within Each User Story

- Backend tests MUST fail before implementation
- Shared assistant and retrieval seams land before route rewiring
- Settings aggregation lands before frontend settings migration
- MCP remapping lands before MCP documentation updates
- OpenAPI generation happens only after the runtime contracts are implemented
- Playwright coverage lands after the visible settings and history flows exist

### Parallel Opportunities

- Foundational tests can run in parallel across contract and unit files
- US1 authenticated and public-chat tests can run in parallel
- US2 retrieval endpoint work and MCP adapter work can run in parallel once retrieval routes exist
- US3 backend settings aggregation and frontend settings client work can run in parallel after the shared settings schema is defined
- US5 documentation updates can run in parallel across README, docs, and MCP package wording

---

## Parallel Example: User Story 2

```bash
# Launch failing retrieval and MCP coverage together:
Task: "Add failing contract coverage for POST /api/v1/retrieval/search and POST /api/v1/retrieval/answer in backend/tests/contract/retrieval-search.contract.test.ts and backend/tests/contract/retrieval-answer.contract.test.ts"
Task: "Add failing integration coverage for retrieval-only answer, retrieval-only rewrite continuity, and typed unsupported outcomes in backend/tests/integration/retrieval-answer.integration.test.ts"
Task: "Add failing MCP package coverage for grounded-answer remapping in packages/radioso-mcp-server/tests/radiosoApiAdapter.test.ts, packages/radioso-mcp-server/tests/readTools.test.ts, and packages/radioso-mcp-server/tests/httpBackendIntegration.test.ts"

# After retrieval routes exist, wire parallel consumers:
Task: "Implement grounded-answer orchestration and typed unsupported_query_type outcomes in backend/src/modules/retrieval/services/retrievalAnswerService.ts"
Task: "Update packages/radioso-mcp-server/src/radiosoApiAdapter.ts, packages/radioso-mcp-server/src/tools/readTools.ts, and packages/radioso-mcp-server/src/types.ts so MCP grounded answers use /api/v1/retrieval/answer"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Complete Setup + Foundational
2. Deliver US1 so human-facing chat is assistant-owned
3. Deliver US2 so retrieval remains standalone for headless and MCP clients
4. Validate both surfaces independently before moving on

### Incremental Delivery

1. Extract the assistant and retrieval seams
2. Rewire human chat to the assistant contract
3. Re-expose retrieval as standalone search and answer
4. Merge settings into one platform resource
5. Restore diagnostics and shared history clarity
6. Publish the explicit contract in OpenAPI and docs

### Review Strategy

1. Complete implementation and targeted validation
2. Run a separate review pass focused on regressions, missing tests, and boundary drift
3. Verify that the shipped docs and OpenAPI contract match runtime behavior before merge readiness

## Notes

- [P] tasks touch different files and avoid same-file conflicts
- Runtime prompt assets introduced or moved by this feature must live under `backend/prompts/`
- The new shared `GET/PUT /api/v1/settings` contract must stay merge-safe across assistant, retrieval, and channels sections
- Retrieval-only endpoints must never synthesize assistant persona or social behavior
