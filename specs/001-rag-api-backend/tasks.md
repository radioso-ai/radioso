# Tasks: Modular RAG Backend

**Input**: Design documents from `/Users/dm/code/radioso/specs/001-rag-api-backend/`
**Prerequisites**: [plan.md](/Users/dm/code/radioso/specs/001-rag-api-backend/plan.md), [spec.md](/Users/dm/code/radioso/specs/001-rag-api-backend/spec.md), [research.md](/Users/dm/code/radioso/specs/001-rag-api-backend/research.md), [data-model.md](/Users/dm/code/radioso/specs/001-rag-api-backend/data-model.md), [contracts/openapi.yaml](/Users/dm/code/radioso/specs/001-rag-api-backend/contracts/openapi.yaml)

**Tests**: Backend tests are REQUIRED and MUST be written before implementation tasks in each user story phase.

**Organization**: Tasks are grouped by user story so each story can be implemented and verified independently once foundational work is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel when dependencies are satisfied
- **[Story]**: Maps the task to a user story from the spec
- Every task includes an exact file path

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the backend workspace, toolchain, and contract baseline

- [x] T001 Create the backend service directory structure in `/Users/dm/code/radioso/backend/` with `src/`, `tests/`, and `db/` subdirectories per `/Users/dm/code/radioso/specs/001-rag-api-backend/plan.md`
- [x] T002 Initialize the Node.js/TypeScript project manifest in `/Users/dm/code/radioso/backend/package.json` with Express, `pg`, OpenAI SDK, Zod, Pino, Vitest, and Supertest dependencies
- [x] T003 [P] Create TypeScript build configuration in `/Users/dm/code/radioso/backend/tsconfig.json`
- [x] T004 [P] Create environment templates in `/Users/dm/code/radioso/backend/.env.example` documenting `DATABASE_URL`, `OPENAI_API_KEY`, `OPENAI_CHAT_MODEL`, `OPENAI_VECTOR_MODEL`, `SESSION_COOKIE_SECRET`, and `PORT`
- [x] T005 Copy and align the contract draft from `/Users/dm/code/radioso/specs/001-rag-api-backend/contracts/openapi.yaml` to `/Users/dm/code/radioso/backend/openapi.yaml`
- [x] T006 [P] Create the test runner and local scripts in `/Users/dm/code/radioso/backend/package.json` for unit, integration, contract, and full test execution
- [x] T059 [P] Create container environment templates in `/Users/dm/code/radioso/infra/.env.example` for Docker-based local runtime configuration
- [x] T060 [P] Create Docker runtime artifacts in `/Users/dm/code/radioso/infra/backend.Dockerfile` and `/Users/dm/code/radioso/infra/docker-compose.yml` to run the backend with PostgreSQL + `pgvector`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the shared infrastructure required by every user story

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Create Postgres migration bootstrap files in `/Users/dm/code/radioso/backend/src/db/migrations/` for accounts, sessions, account tokens, retrieval settings, documents, chunks, conversations, messages, and audit events
- [x] T008 [P] Implement database connection and transaction helpers in `/Users/dm/code/radioso/backend/src/shared/infra/database.ts`
- [x] T009 [P] Implement centralized environment parsing in `/Users/dm/code/radioso/backend/src/app/config/env.ts`
- [x] T010 [P] Implement logger and request correlation plumbing in `/Users/dm/code/radioso/backend/src/shared/observability/logger.ts`
- [x] T011 Create the Express app bootstrap in `/Users/dm/code/radioso/backend/src/app/server/createApp.ts`
- [x] T012 [P] Implement shared HTTP error mapping middleware in `/Users/dm/code/radioso/backend/src/app/http/middleware/errorHandler.ts`
- [x] T013 [P] Implement shared request validation middleware in `/Users/dm/code/radioso/backend/src/app/http/middleware/validate.ts`
- [x] T014 [P] Implement OpenAI gateway bootstrap for chat and embedding models in `/Users/dm/code/radioso/backend/src/shared/infra/openaiClient.ts`
- [x] T015 Implement the HTTP route registration entrypoint in `/Users/dm/code/radioso/backend/src/app/http/routes/index.ts`

**Checkpoint**: Foundation ready. User story work can now proceed.

---

## Phase 3: User Story 1 - Provision a Knowledge Account (Priority: P1) 🎯 MVP

**Goal**: Deliver registration, login, `HttpOnly` session cookies, and single-token account access

**Independent Test**: Register a new account, log in as an existing account, and retrieve the single active API token through an authenticated session without touching document or chat endpoints

### Tests for User Story 1 (REQUIRED for backend)

- [x] T016 [P] [US1] Write the auth contract tests for `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, and `GET /api/v1/account/token` in `/Users/dm/code/radioso/backend/tests/contract/auth.contract.test.ts`
- [x] T017 [P] [US1] Write the auth integration tests for registration, duplicate email rejection, invalid login, session cookie issuance, and token retrieval in `/Users/dm/code/radioso/backend/tests/integration/auth.integration.test.ts`
- [x] T018 [P] [US1] Write unit tests for password hashing, session token generation, and account token hashing in `/Users/dm/code/radioso/backend/tests/unit/auth.domain.test.ts`

### Implementation for User Story 1

- [x] T019 [P] [US1] Implement the account and session repositories in `/Users/dm/code/radioso/backend/src/db/repositories/accountRepository.ts` and `/Users/dm/code/radioso/backend/src/db/repositories/sessionRepository.ts`
- [x] T020 [P] [US1] Implement the single account-token repository in `/Users/dm/code/radioso/backend/src/db/repositories/accountTokenRepository.ts`
- [x] T021 [P] [US1] Implement auth domain helpers for password hashing, session cookies, and API token generation in `/Users/dm/code/radioso/backend/src/modules/auth/domain/authPrimitives.ts`
- [x] T022 [US1] Implement registration, login, and token retrieval services in `/Users/dm/code/radioso/backend/src/modules/auth/services/authService.ts`
- [x] T023 [P] [US1] Implement session-auth middleware in `/Users/dm/code/radioso/backend/src/app/http/middleware/requireSession.ts`
- [x] T024 [US1] Implement auth route handlers in `/Users/dm/code/radioso/backend/src/app/http/routes/authRoutes.ts`
- [x] T025 [US1] Implement account-token route handler in `/Users/dm/code/radioso/backend/src/app/http/routes/accountRoutes.ts`
- [x] T026 [US1] Add audit event recording for registration, login, and token retrieval failures in `/Users/dm/code/radioso/backend/src/modules/audit/services/auditService.ts`

**Checkpoint**: User Story 1 is independently functional and testable.

---

## Phase 4: User Story 2 - Ingest Account Documents And Manage Retrieval Settings (Priority: P2)

**Goal**: Deliver bearer-authenticated document ingestion plus per-account retrieval settings management

**Independent Test**: Use an account token to read and update retrieval settings, then ingest a document and confirm it is normalized, chunked, embedded, and stored for that same account

### Tests for User Story 2 (REQUIRED for backend)

- [x] T027 [P] [US2] Write contract tests for `GET /api/v1/settings/retrieval` and `PUT /api/v1/settings/retrieval` in `/Users/dm/code/radioso/backend/tests/contract/settings.contract.test.ts`
- [x] T028 [P] [US2] Write the contract test for `POST /api/v1/document/` in `/Users/dm/code/radioso/backend/tests/contract/document.contract.test.ts`
- [x] T029 [P] [US2] Write integration tests for settings validation, token auth, document ingestion, and account scoping in `/Users/dm/code/radioso/backend/tests/integration/document-settings.integration.test.ts`
- [x] T030 [P] [US2] Write unit tests for recursive chunk overlap and retrieval settings validation in `/Users/dm/code/radioso/backend/tests/unit/retrieval-settings-and-chunking.test.ts`

### Implementation for User Story 2

- [x] T031 [P] [US2] Implement bearer-token auth middleware in `/Users/dm/code/radioso/backend/src/app/http/middleware/requireApiToken.ts`
- [x] T032 [P] [US2] Implement retrieval settings repository in `/Users/dm/code/radioso/backend/src/db/repositories/retrievalSettingsRepository.ts`
- [x] T033 [P] [US2] Implement settings validation rules in `/Users/dm/code/radioso/backend/src/modules/settings/domain/retrievalSettings.ts`
- [x] T034 [US2] Implement retrieval settings service in `/Users/dm/code/radioso/backend/src/modules/settings/services/retrievalSettingsService.ts`
- [x] T035 [US2] Implement settings route handlers in `/Users/dm/code/radioso/backend/src/app/http/routes/settingsRoutes.ts`
- [x] T036 [P] [US2] Implement document and chunk repositories in `/Users/dm/code/radioso/backend/src/db/repositories/documentRepository.ts` and `/Users/dm/code/radioso/backend/src/db/repositories/chunkRepository.ts`
- [x] T037 [P] [US2] Implement markdown normalization and recursive chunking in `/Users/dm/code/radioso/backend/src/modules/retrieval/domain/chunkingService.ts`
- [x] T038 [P] [US2] Implement embedding persistence orchestration in `/Users/dm/code/radioso/backend/src/modules/retrieval/services/embeddingService.ts`
- [x] T039 [US2] Implement document ingestion service in `/Users/dm/code/radioso/backend/src/modules/documents/services/documentIngestionService.ts`
- [x] T040 [US2] Implement document ingestion route handler in `/Users/dm/code/radioso/backend/src/app/http/routes/documentRoutes.ts`
- [x] T041 [US2] Add audit events for settings updates and document ingestion failures in `/Users/dm/code/radioso/backend/src/modules/audit/services/auditService.ts`

**Checkpoint**: User Story 2 is independently functional and testable with User Story 1 complete.

---

## Phase 5: User Story 3 - Ask Retrieval-Grounded Questions (Priority: P3)

**Goal**: Deliver conversation-based RAG chat with optional query rewrite, optional rerank, and streaming/non-streaming responses

**Independent Test**: With a token-authenticated account that has ingested content, create a new conversation by calling `POST /api/v1/chat/` without `conversationId`, receive either JSON or SSE output, then continue the conversation with follow-up questions and confirm retrieval remains account-scoped

### Tests for User Story 3 (REQUIRED for backend)

- [x] T042 [P] [US3] Write the contract tests for `POST /api/v1/chat/` covering streaming and non-streaming responses in `/Users/dm/code/radioso/backend/tests/contract/chat.contract.test.ts`
- [x] T043 [P] [US3] Write integration tests for conversation creation, follow-up chat, no-result retrieval, and account isolation in `/Users/dm/code/radioso/backend/tests/integration/chat.integration.test.ts`
- [x] T044 [P] [US3] Write unit tests for prompt building, query rewrite toggles, rerank toggles, and similarity-threshold filtering in `/Users/dm/code/radioso/backend/tests/unit/chat-retrieval.domain.test.ts`

### Implementation for User Story 3

- [x] T045 [P] [US3] Implement conversation and message repositories in `/Users/dm/code/radioso/backend/src/db/repositories/conversationRepository.ts` and `/Users/dm/code/radioso/backend/src/db/repositories/messageRepository.ts`
- [x] T046 [P] [US3] Implement pgvector similarity search in `/Users/dm/code/radioso/backend/src/modules/retrieval/infra/vectorSearch.ts`
- [x] T047 [P] [US3] Implement prompt building, query rewrite, and rerank services in `/Users/dm/code/radioso/backend/src/modules/retrieval/services/promptBuilder.ts`, `/Users/dm/code/radioso/backend/src/modules/retrieval/services/queryRewriteService.ts`, and `/Users/dm/code/radioso/backend/src/modules/retrieval/services/rerankService.ts`
- [x] T048 [US3] Implement retrieval orchestration pipeline in `/Users/dm/code/radioso/backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [x] T049 [P] [US3] Implement SSE and JSON chat presenters in `/Users/dm/code/radioso/backend/src/app/http/presenters/chatPresenter.ts`
- [x] T050 [US3] Implement conversation-aware chat service in `/Users/dm/code/radioso/backend/src/modules/chat/services/chatService.ts`
- [x] T051 [US3] Implement chat route handler in `/Users/dm/code/radioso/backend/src/app/http/routes/chatRoutes.ts`
- [x] T052 [US3] Add audit and observability coverage for chat execution and upstream model failures in `/Users/dm/code/radioso/backend/src/modules/audit/services/auditService.ts` and `/Users/dm/code/radioso/backend/src/shared/observability/logger.ts`

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final contract alignment, operational hardening, and full-flow verification

- [x] T053 [P] Synchronize the final implementation contract in `/Users/dm/code/radioso/backend/openapi.yaml` with the implemented handlers and schemas
- [x] T054 [P] Add repository and retrieval-flow integration coverage for migrations and pgvector queries in `/Users/dm/code/radioso/backend/tests/integration/persistence.integration.test.ts`
- [x] T055 [P] Add additional unit coverage for edge cases in `/Users/dm/code/radioso/backend/tests/unit/edge-cases.test.ts`
- [x] T056 Harden HTTP security and cookie settings in `/Users/dm/code/radioso/backend/src/app/server/createApp.ts` and `/Users/dm/code/radioso/backend/src/app/http/middleware/requireSession.ts`
- [x] T057 Validate the local runbook and setup instructions in `/Users/dm/code/radioso/specs/001-rag-api-backend/quickstart.md`
- [x] T058 Run the full backend validation flow and record results in `/Users/dm/code/radioso/specs/001-rag-api-backend/quickstart.md`
- [x] T061 Validate Docker Compose startup and backend health checks using `/Users/dm/code/radioso/infra/docker-compose.yml` and `/Users/dm/code/radioso/backend/src/app/http/routes/index.ts`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup**: No dependencies
- **Phase 2: Foundational**: Depends on Phase 1 and blocks all user stories
- **Phase 3: User Story 1**: Depends on Phase 2
- **Phase 4: User Story 2**: Depends on Phase 2 and uses auth/token capabilities from User Story 1 for realistic end-to-end validation
- **Phase 5: User Story 3**: Depends on Phases 2, 3, and 4 because chat requires account auth, account tokens, retrieval settings, documents, and chunks
- **Phase 6: Polish**: Depends on all completed user stories

### User Story Dependencies

- **User Story 1 (P1)**: No story dependencies after foundational work; this is the MVP
- **User Story 2 (P2)**: Requires the single-token account auth delivered by User Story 1
- **User Story 3 (P3)**: Requires both auth/token flow from User Story 1 and ingest/settings flow from User Story 2

### Within Each User Story

- Write contract, integration, and unit tests first and confirm they fail
- Create repositories and domain modules before orchestration services
- Complete orchestration services before route handlers and presenters
- Keep route handlers transport-only and keep `vectorSearch.ts` similarity-query-only

### Parallel Opportunities

- Phase 1 tasks marked `[P]` can run together after `T002`
- Docker setup tasks `T059` and `T060` can run in parallel with the remaining
  Phase 1 scaffolding once the backend package shape is established
- Phase 2 tasks `T008`, `T009`, `T010`, `T012`, `T013`, and `T014` can run in parallel after `T007`
- In User Story 1, `T016`-`T018` can run in parallel, then `T019`-`T021` and `T023` can run in parallel
- In User Story 2, `T027`-`T030` can run in parallel, then `T031`-`T038` can be split across auth, settings, and ingestion modules
- In User Story 3, `T042`-`T044` can run in parallel, then `T045`-`T047` and `T049` can run in parallel before orchestration tasks

---

## Parallel Example: User Story 2

```bash
# Tests first
Task: "Write the contract tests for GET/PUT /api/v1/settings/retrieval in /Users/dm/code/radioso/backend/tests/contract/settings.contract.test.ts"
Task: "Write the contract test for POST /api/v1/document/ in /Users/dm/code/radioso/backend/tests/contract/document.contract.test.ts"
Task: "Write integration tests for settings validation, token auth, document ingestion, and account scoping in /Users/dm/code/radioso/backend/tests/integration/document-settings.integration.test.ts"

# Parallel implementation after tests fail
Task: "Implement retrieval settings repository in /Users/dm/code/radioso/backend/src/db/repositories/retrievalSettingsRepository.ts"
Task: "Implement document and chunk repositories in /Users/dm/code/radioso/backend/src/db/repositories/documentRepository.ts and /Users/dm/code/radioso/backend/src/db/repositories/chunkRepository.ts"
Task: "Implement markdown normalization and recursive chunking in /Users/dm/code/radioso/backend/src/modules/retrieval/domain/chunkingService.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases
2. Complete User Story 1
3. Validate registration, login, session cookie issuance, and account-token retrieval independently
4. Stop for review before moving into ingestion and chat

### Incremental Delivery

1. Deliver User Story 1 as the first usable slice
2. Add User Story 2 to create retrievable account knowledge
3. Add User Story 3 for end-user RAG value with conversations and streaming
4. Finish with contract alignment, hardening, and full validation

### Parallel Team Strategy

1. One engineer owns backend scaffolding and migrations in Phases 1-2
2. One engineer can own User Story 1 auth/account flow
3. One engineer can own User Story 2 settings/ingestion flow once auth contracts are stable
4. One engineer can own User Story 3 retrieval/chat flow once ingestion contracts and repositories are stable

---

## Notes

- Total tasks: 61
- All tasks follow the required checklist format with IDs, optional `[P]`, story labels where required, and exact file paths
- Backend TDD is explicit: tests precede implementation in every user story phase
- `backend/openapi.yaml` remains the shared contract source of truth and must stay synchronized with implemented handlers
