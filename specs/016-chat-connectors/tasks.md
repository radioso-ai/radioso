# Tasks: Chat Connector Plugin System

**Input**: Design documents from `/specs/016-chat-connectors/`
**Prerequisites**: spec.md (required)

**Tests**: Backend tests are REQUIRED per constitution (TDD). Tests MUST be written and FAIL before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

**Architecture**: All new code lives in `backend/src/modules/connectors/`. Only 3 existing files are modified minimally: `dependencies.ts`, `routes/index.ts`, `settings-view.tsx`. Module ownership per plan.md is enforced.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Backend**: `backend/src/`, `backend/tests/`
- **Frontend**: `frontend/components/`, `frontend/lib/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create module structure, shared types, and configuration

- [X] T001 Create connector module directory structure: `backend/src/modules/connectors/{domain,services,plugins/whatsapp,http}` and test directories: `backend/tests/unit/connectors/whatsapp/`, `backend/tests/contract/connectors/`, `backend/tests/integration/connectors/`
- [X] T002 [P] Define `ConnectorPlugin` interface, `ConnectorContext` type, and related types in `backend/src/modules/connectors/domain/connectorPlugin.ts` — `ConnectorPlugin` includes: `id`, `name`, `description`, `configSchema()`, `migrate()`, `initialize(context)`, `shutdown()`, `getWebhookUrl()`. `ConnectorContext` includes: `db`, `logger`, `chatService`, `router` (the scoped API surface passed to each plugin at init)
- [X] T003 [P] Define config schema field types (`text`, `secret`, `toggle`, `select`) and `ConnectorConfig` type in `backend/src/modules/connectors/domain/configSchema.ts`
- [X] T004 [P] Add `CONNECTOR_ENCRYPTION_KEY` to `.env.example` with generation instructions

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

### Tests for Foundational Phase

- [X] T005 [P] Unit tests for config encryption (encrypt, decrypt, mask) in `backend/tests/unit/connectors/configEncryption.test.ts` — test AES-256-GCM round-trip, unique IVs, masking to last 4 chars, error on invalid key
- [X] T006 [P] Unit tests for `ConnectorRegistry` in `backend/tests/unit/connectors/connectorRegistry.test.ts` — test: register plugin, list plugins, run migrations, initialize/shutdown lifecycle, get plugin by id

### Implementation for Foundational Phase

- [X] T007 Implement config encryption service in `backend/src/modules/connectors/services/configEncryption.ts` — AES-256-GCM encrypt/decrypt with per-field IV, mask function showing last 4 chars, reads `CONNECTOR_ENCRYPTION_KEY` from env
- [X] T008 Create core migration `backend/src/db/migrations/007_connector_config.sql` — creates `connector_configs` table (id, workspace_id, connector_id, enabled, config_data JSONB, error_status, created_at, updated_at) with unique constraint on (workspace_id, connector_id), and `connector_migrations` table (id, connector_id, migration_name, applied_at) with unique constraint on (connector_id, migration_name). Also adds `source_channel` column (VARCHAR, nullable, default NULL) to the existing `conversations` table per FR-010 — NULL means web, non-NULL values like `'whatsapp'` identify connector-originated conversations
- [X] T009 Implement `ConnectorRegistry` in `backend/src/modules/connectors/services/connectorRegistry.ts` — register plugins, run core + plugin migrations, initialize all enabled connectors at startup, mount plugin routes under shared Express router, shutdown gracefully, list plugins with per-workspace status, get/save/validate config with encryption for secret fields, enforce unique channel identity on save (per FR-012: reject with 409 if another workspace already has the same connector-declared unique field value enabled)
- [X] T010 Implement connector REST routes in `backend/src/modules/connectors/http/connectorRoutes.ts` — endpoints per contracts/connectors-api.yaml: `GET /api/v1/connectors` (list), `GET /api/v1/connectors/:connectorId` (detail + schema + config), `PUT /api/v1/connectors/:connectorId` (save config), `POST /api/v1/connectors/:connectorId/enable`, `POST /api/v1/connectors/:connectorId/disable`
- [X] T011 Wire `ConnectorRegistry` in `backend/src/app/server/dependencies.ts` — instantiate registry with database, logger; add to `AppDependencies` interface in `backend/src/app/server/types.ts`
- [X] T012 Mount connector routes in `backend/src/app/http/routes/index.ts` — add `app.use()` for connector routes from registry's router

**Checkpoint**: Foundation ready — connector infrastructure operational, no connectors registered yet

---

## Phase 3: User Story 1 — Enable a Chat Connector for a Workspace (Priority: P1) MVP

**Goal**: Admin can see WhatsApp in Settings > Chat Connectors, configure it, and enable/disable it per workspace.

**Independent Test**: Navigate to Settings > Chat Connectors, fill in WhatsApp config fields, enable, verify status persists across page loads.

### Tests for User Story 1

- [X] T013 [P] [US1] Contract tests for connector management endpoints in `backend/tests/contract/connectors/connectorRoutes.test.ts` — test: list connectors returns whatsapp, get detail returns schema + masked secrets, save config persists, enable validates required fields, disable preserves config, 409 on duplicate phone number across workspaces
- [X] T014 [P] [US1] Unit tests for WhatsApp plugin config schema and validation in `backend/tests/unit/connectors/whatsapp/whatsappPlugin.test.ts` — test: schema declares all 6 fields (phone_number_id, access_token, app_secret, webhook_verify_token, business_account_id, conversation_timeout_hours), required field validation, webhook URL generation

### Implementation for User Story 1

- [X] T015 [P] [US1] Create WhatsApp plugin migration in `backend/src/modules/connectors/plugins/whatsapp/migration.sql` — creates `connector_whatsapp_contacts` table (id, wa_id, profile_name, workspace_id, conversation_id, first_seen_at, last_message_at) with unique (workspace_id, wa_id), and `connector_whatsapp_message_log` table (id, wamid unique, direction, workspace_id, wa_id, message_type, payload JSONB, status, error_details, created_at) with indexes on (workspace_id, wa_id, created_at DESC), (created_at), (wamid)
- [X] T016 [US1] Implement WhatsApp plugin in `backend/src/modules/connectors/plugins/whatsapp/whatsappPlugin.ts` — implements `ConnectorPlugin` interface: id `whatsapp`, config schema with 6 fields, migration runner for whatsapp tables, `getWebhookUrl()` returning `/api/connectors/whatsapp/<workspace_id>/webhook`, config validation (all required fields present)
- [X] T017 [US1] Register WhatsApp plugin in `backend/src/app/server/dependencies.ts` — create WhatsApp plugin instance and register with `ConnectorRegistry`
- [X] T018 [P] [US1] Add `connectorsApi` service to frontend API client in `frontend/lib/api.ts` — functions: `listConnectors(workspaceId)`, `getConnector(workspaceId, connectorId)`, `saveConnectorConfig(workspaceId, connectorId, config)`, `enableConnector(workspaceId, connectorId)`, `disableConnector(workspaceId, connectorId)`
- [X] T019 [P] [US1] Create connector card component in `frontend/components/dashboard/connectors/connector-card.tsx` — displays connector name, description, enabled/disabled badge, error status warning badge; clickable to open config
- [X] T020 [P] [US1] Create schema-driven config form in `frontend/components/dashboard/connectors/connector-config-form.tsx` — renders fields from connector schema: Input for text, Input type=password for secret (masked with "change" action), Switch for toggle, Select for select; shows read-only webhook URL; enable/disable toggle; save button; inline validation errors
- [X] T021 [US1] Create connectors tab in `frontend/components/dashboard/connectors/connectors-tab.tsx` — fetches connector list, renders connector cards, handles card click to show config form panel, manages save/enable/disable API calls with loading/error states
- [X] T022 [US1] Add "Chat Connectors" tab to settings in `frontend/components/dashboard/settings-view.tsx` — add tab entry alongside existing tabs, render `ConnectorsTab` component

**Checkpoint**: Admin can configure and enable/disable WhatsApp connector via Settings UI. No message processing yet.

---

## Phase 4: User Story 2 — Receive and Respond to Messages via WhatsApp (Priority: P2)

**Goal**: Incoming WhatsApp messages are processed through the chat pipeline and replies sent back via WhatsApp.

**Independent Test**: Send a webhook POST (simulated or real) with a text message, verify: message logged, ChatService called, reply sent back via Cloud API, conversation created in history.

### Tests for User Story 2

- [X] T023 [P] [US2] Unit tests for webhook handler in `backend/tests/unit/connectors/whatsapp/whatsappWebhook.test.ts` — test: GET verification (valid token → 200 + challenge, invalid → 403), POST signature verification (valid → 200, invalid/missing → 401), POST with text message → acknowledged, POST with status update → acknowledged and ignored, POST with unsupported type → fallback reply, duplicate wamid → acknowledged but not re-processed
- [X] T024 [P] [US2] Unit tests for WhatsApp Cloud API client in `backend/tests/unit/connectors/whatsapp/whatsappClient.test.ts` — test: send text message constructs correct Graph API request, handles 401/429/400 errors, returns wamid from response
- [X] T025 [P] [US2] Unit tests for message handler in `backend/tests/unit/connectors/whatsapp/whatsappMessageHandler.test.ts` — test: debounce combines rapid messages (3s window), single message processed after timeout, calls ChatService.answer(), maps wa_id to conversation (new contact → new conversation, existing contact within timeout → same conversation, existing contact past timeout → new conversation), stores message log entries with correct status transitions
- [X] T026 [P] [US2] Integration test for full WhatsApp message flow in `backend/tests/integration/connectors/whatsappFlow.test.ts` — test: simulate webhook POST → message logged → ChatService called → reply sent → conversation in history; test with fake ChatService and fake HTTP client

### Implementation for User Story 2

- [X] T027 [P] [US2] Implement WhatsApp Cloud API client in `backend/src/modules/connectors/plugins/whatsapp/whatsappClient.ts` — send text message via POST to `graph.facebook.com/v21.0/<phone_number_id>/messages`, handle error responses (401 → auth error, 429 → rate limit with backoff, 400 → bad request), structured logging for send success/failure
- [X] T028 [P] [US2] Implement webhook handler in `backend/src/modules/connectors/plugins/whatsapp/whatsappWebhook.ts` — GET route for verification handshake (validate verify_token, return challenge), POST route with X-Hub-Signature-256 HMAC-SHA256 verification (constant-time comparison using app_secret), parse payload to extract messages vs statuses vs reactions, deduplicate by wamid (lookup in message_log, skip if already exists per WA-003), acknowledge with 200 immediately, dispatch to message handler asynchronously, structured logging for webhook received / signature failed / duplicate skipped
- [X] T029 [US2] Implement message handler in `backend/src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.ts` — per-sender debounce (3s window using setTimeout, buffer messages, concatenate with newlines), conversation identity mapping (lookup contact by wa_id + workspace_id, check last_message_at against conversation_timeout_hours, create new conversation via ChatService if expired or new contact, update contact record), call `ChatService.answer()` with combined message text, send reply via whatsappClient, update message log status (received → processing → replied/failed), handle unsupported message types with fallback text reply, structured logging for processing started / reply sent / reply failed
- [X] T030 [US2] Wire webhook routes in WhatsApp plugin's `initialize()` method in `backend/src/modules/connectors/plugins/whatsapp/whatsappPlugin.ts` — mount GET and POST webhook routes on the plugin's router at `/api/connectors/whatsapp/:workspaceId/webhook`, pass ConnectorContext (db, logger, chatService) to handlers

**Checkpoint**: Full WhatsApp message flow works end-to-end. Messages in, answers out, conversations tracked.

---

## Phase 5: User Story 3 — Disable and Reconfigure a Connector (Priority: P3)

**Goal**: Admin can disable an active connector (stops message processing), reconfigure, and re-enable. Past conversations preserved.

**Independent Test**: Disable enabled connector, send webhook (verify 200 ack but no processing), edit config, re-enable, send webhook (verify processing resumes). Check chat history still shows old conversations.

### Tests for User Story 3

- [X] T031 [P] [US3] Contract tests for disable/re-enable flow in `backend/tests/contract/connectors/connectorLifecycle.test.ts` — test: disable returns updated status, webhook to disabled connector is acknowledged but not processed, re-enable with same config works, re-enable with updated config saves new values, past conversations remain in history after disable
- [X] T032 [P] [US3] Unit test for connector error status handling in `backend/tests/unit/connectors/whatsapp/whatsappPlugin.test.ts` — test: runtime error (401 from Cloud API) updates error_status on connector config, clearing config and re-enabling clears error_status

### Implementation for User Story 3

- [X] T033 [US3] Add disabled-connector guard to webhook handler in `backend/src/modules/connectors/plugins/whatsapp/whatsappWebhook.ts` — on POST, check if connector is enabled for the workspace; if disabled, acknowledge with 200 but skip processing; log as structured event
- [X] T034 [US3] Implement error status propagation in `backend/src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.ts` — when Cloud API returns persistent auth errors (401), update `connector_configs.error_status` for the workspace; when admin re-saves config or re-enables, clear `error_status`
- [X] T035 [US3] Update connector config form to show error status in `frontend/components/dashboard/connectors/connector-config-form.tsx` — display `errorStatus` as a warning alert above the form when present; auto-clear on successful save

**Checkpoint**: Full lifecycle management works. Disable/reconfigure/re-enable flow complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that span multiple user stories

- [X] T036 [P] Implement message log retention cleanup in `backend/src/modules/connectors/plugins/whatsapp/whatsappPlugin.ts` — add a method called during `initialize()` that schedules periodic deletion (e.g. daily) of `connector_whatsapp_message_log` rows older than 90 days (per WA-012)
- [X] T037 End-to-end smoke test — manually or via script: configure WhatsApp connector in UI, simulate webhook POST, verify response sent, disable connector, verify webhook is acknowledged but not processed, check chat history shows conversation with `source_channel = 'whatsapp'`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 completion
- **User Story 2 (Phase 4)**: Depends on Phase 2 completion. Can run in parallel with US1 (backend parts), but webhook routes in T030 depend on T016 (plugin implementation from US1)
- **User Story 3 (Phase 5)**: Depends on US2 completion (needs webhook handler and message handler to exist)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Independent after Phase 2. Delivers admin UI config flow.
- **US2 (P2)**: Backend tests/implementation can start after Phase 2, but T030 (webhook route wiring) depends on T016 from US1. Delivers message processing.
- **US3 (P3)**: Depends on US2 (modifies webhook handler and message handler from US2). Delivers lifecycle management.

### Within Each User Story

- Backend tests MUST be written and FAIL before implementation
- Models/migrations before services
- Services before routes/endpoints
- Backend before frontend (frontend calls backend API)

### Parallel Opportunities

- T002, T003, T004 (Phase 1 setup) — all independent files
- T005, T006 (Phase 2 tests) — independent test files
- T007, T008 (Phase 2 implementation) — encryption service and migration are independent
- T013, T014 (US1 tests) — independent test files
- T015, T016 in parallel with T018, T019, T020 (US1 backend plugin + frontend components)
- T023, T024, T025, T026 (US2 tests) — all independent test files
- T027, T028 (US2 Cloud API client + webhook handler) — independent files
- T031, T032 (US3 tests) — independent test files
- T036, T037 (Polish) — independent

---

## Parallel Example: User Story 2

```bash
# Launch all tests in parallel:
Task: T023 "Unit tests for webhook handler"
Task: T024 "Unit tests for WhatsApp client"
Task: T025 "Unit tests for message handler"
Task: T026 "Integration test for full flow"

# Then launch independent implementations in parallel:
Task: T027 "Implement WhatsApp Cloud API client"
Task: T028 "Implement webhook handler"

# Then sequential (depends on T027, T028):
Task: T029 "Implement message handler"
Task: T030 "Wire webhook routes in plugin"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T004)
2. Complete Phase 2: Foundational (T005–T012)
3. Complete Phase 3: User Story 1 (T013–T022)
4. **STOP and VALIDATE**: Admin can configure and enable WhatsApp connector via UI
5. Deploy/demo if ready — no message processing yet, but config management works

### Incremental Delivery

1. Setup + Foundational → Connector infrastructure operational
2. Add User Story 1 → Admin config flow works → Deploy (MVP!)
3. Add User Story 2 → Messages flow end-to-end → Deploy
4. Add User Story 3 → Full lifecycle management → Deploy
5. Polish → Retention cleanup, channel uniqueness enforcement → Deploy

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Each user story is independently testable at its checkpoint
- Commit after each task or logical group
- Total: 37 tasks (4 setup, 8 foundational, 10 US1, 8 US2, 5 US3, 2 polish)
