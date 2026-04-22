# Tasks: OSS Observability

**Input**: Design documents from `/specs/045-oss-observability/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md

**Tests**: Backend tests are required and MUST be written before implementation tasks. Frontend tests are only required if client-side analytics emitters are added in later phases.

**Organization**: Tasks are grouped by user story to preserve independent delivery and review boundaries.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish planning docs and file seams before runtime changes begin

- [x] T001 Create focused backend directories for `backend/src/shared/observability/telemetry/`, `backend/src/shared/analytics/`, and `backend/src/shared/incidents/`
- [x] T002 Create implementation stubs for shared event types and sink interfaces in `backend/src/shared/observability/telemetry/`, `backend/src/shared/analytics/`, and `backend/src/shared/incidents/`
- [x] T003 Review `backend/src/app/server/types.ts` and dependency wiring boundaries so new observability services can be added without bloating existing composition code

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core seams that must exist before user-story implementation can proceed

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Create runtime configuration coverage for observability flags in `backend/tests/unit/runtime-config.test.ts`
- [x] T005 [P] Create shared redaction and correlation helper tests in `backend/tests/unit/telemetry-redaction.test.ts`
- [x] T006 [P] Create shared event taxonomy tests in `backend/tests/unit/product-analytics-events.test.ts`
- [x] T007 Implement shared correlation helpers in `backend/src/shared/observability/telemetry/correlation.ts`
- [x] T008 Implement shared redaction policy helpers in `backend/src/shared/observability/telemetry/redactionPolicy.ts`
- [x] T009 Implement internal event type definitions in `backend/src/shared/analytics/productAnalyticsTypes.ts` and `backend/src/shared/incidents/incidentTypes.ts`
- [x] T010 Implement sink interfaces and default no-op or first-party contracts in `backend/src/shared/observability/telemetry/telemetrySink.ts`, `backend/src/shared/analytics/productAnalyticsSink.ts`, and `backend/src/shared/incidents/incidentSink.ts`

**Checkpoint**: Shared observability types, configuration, redaction, and sink seams exist

---

## Phase 3: User Story 1 - Define An OSS-Safe Default Observability Architecture (Priority: P1) 🎯 MVP

**Goal**: Deliver first-party runtime telemetry and incident capture that work without vendor adapters

**Independent Test**: Run the backend without external sink configuration and verify structured logs, first-party telemetry, and incident capture all work

### Tests for User Story 1 (REQUIRED for backend)

- [x] T011 [P] [US1] Add incident normalization tests in `backend/tests/unit/incident-reporting-service.test.ts`
- [x] T012 [P] [US1] Add telemetry emission tests in `backend/tests/unit/telemetry-service.test.ts`
- [x] T013 [US1] Add runtime integration coverage for unhandled request failures in `backend/tests/integration/runtime-entrypoints.integration.test.ts`

### Implementation for User Story 1

- [x] T014 [P] [US1] Implement telemetry service in `backend/src/shared/observability/telemetry/telemetryService.ts`
- [x] T015 [P] [US1] Implement incident reporting service in `backend/src/shared/incidents/incidentReportingService.ts`
- [x] T016 [US1] Replace ad hoc unhandled-error logging in `backend/src/app/http/middleware/errorHandler.ts` with the incident reporting seam
- [x] T017 [US1] Extend logger helpers in `backend/src/shared/observability/logger.ts` to support correlation and incident metadata without vendor coupling
- [x] T018 [US1] Wire telemetry and incident services into `backend/src/app/server/dependencies.ts` and keep `backend/src/app/server/createApp.ts` orchestration-only
- [x] T019 [US1] Add default-first observability configuration to `backend/src/app/config/env.ts` and `backend/.env.example`

**Checkpoint**: Radioso has a first-party observability path with no vendor dependency

---

## Phase 4: User Story 2 - Preserve A Single Radioso-Owned Event Model Across OSS And SaaS (Priority: P1)

**Goal**: Route product analytics and incident records through Radioso-owned schemas and first-party persistence

**Independent Test**: Trigger representative workspace, document, and chat events and verify they are persisted and emitted in Radioso-defined formats without relying on a vendor SDK

### Tests for User Story 2 (REQUIRED for backend)

- [x] T020 [P] [US2] Add analytics event emission tests in `backend/tests/unit/product-analytics-service.test.ts`
- [x] T021 [P] [US2] Add audit-backed persistence tests in `backend/tests/unit/audit-analytics-sink.test.ts`
- [x] T022 [US2] Add integration coverage for domain event fan-out in `backend/tests/integration/persistence.integration.test.ts`

### Implementation for User Story 2

- [x] T023 [P] [US2] Implement analytics service in `backend/src/shared/analytics/productAnalyticsService.ts`
- [x] T024 [P] [US2] Implement audit-backed analytics sink in `backend/src/shared/analytics/auditEventAnalyticsSink.ts`
- [x] T025 [P] [US2] Implement audit-backed incident sink in `backend/src/shared/incidents/auditIncidentSink.ts`
- [x] T026 [US2] Refine `backend/src/modules/audit/services/auditService.ts` so it can support first-party analytics and incident persistence without becoming sink-specific orchestration
- [x] T027 [US2] Update domain service call sites in `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/documents/services/documentIngestionService.ts`, and `backend/src/modules/settings/services/retrievalSettingsService.ts` to emit Radioso-owned product events through the shared analytics seam

**Checkpoint**: Product analytics and incidents have stable first-party semantics and persistence

---

## Phase 5: User Story 3 - Make Modular Ownership Explicit Before Implementation (Priority: P1)

**Goal**: Keep observability logic out of shared route handlers and oversized orchestration files

**Independent Test**: Review the changed files and verify sink-specific logic lives only in focused observability modules while runtime composition remains thin

### Tests for User Story 3 (REQUIRED for backend)

- [x] T028 [P] [US3] Add dependency wiring tests in `backend/tests/unit/runtime-startup.test.ts`
- [x] T029 [P] [US3] Add retrieval and document instrumentation seam tests in `backend/tests/unit/retrieval-execution-telemetry-service.test.ts`

### Implementation for User Story 3

- [x] T030 [P] [US3] Introduce metrics presentation module in `backend/src/shared/observability/metrics/metricsRegistry.ts`
- [x] T031 [US3] Add optional metrics route wiring in `backend/src/app/http/routes/metricsRoutes.ts` and compose it through `backend/src/app/http/routes/index.ts` without bloating unrelated routes
- [x] T032 [US3] Route retrieval-stage and document-worker telemetry through dedicated services in `backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts` and `backend/src/modules/documents/services/documentProcessingWorker.ts`
- [x] T033 [US3] Keep `backend/src/app/server/dependencies.ts` limited to composition by moving sink creation helpers into `backend/src/shared/observability/telemetry/buildTelemetrySinks.ts`, `backend/src/shared/analytics/buildAnalyticsSinks.ts`, and `backend/src/shared/incidents/buildIncidentSinks.ts`

**Checkpoint**: Ownership seams are explicit and implementation remains modular

---

## Phase 6: User Story 4 - Document Operator Expectations For SaaS-Only Adapters (Priority: P2)

**Goal**: Add optional SaaS-only adapters and deployment guidance without changing the OSS default contract

**Independent Test**: Enable and disable optional adapters through configuration and verify first-party behavior remains intact

### Tests for User Story 4 (REQUIRED for backend)

- [x] T034 [P] [US4] Add optional exporter configuration tests in `backend/tests/unit/runtime-config.test.ts`
- [x] T035 [P] [US4] Add exporter failure-handling tests in `backend/tests/unit/optional-exporters.test.ts`

### Implementation for User Story 4

- [x] T036 [P] [US4] Add optional analytics adapter seam in `backend/src/integrations/posthog/posthogAnalyticsSink.ts`
- [x] T037 [P] [US4] Add optional incident adapter seam in `backend/src/integrations/sentry/sentryIncidentSink.ts`
- [x] T038 [US4] Wire optional adapters through configuration gates in `backend/src/app/server/dependencies.ts` or focused sink builders without changing default behavior
- [x] T039 [US4] Add frontend-only analytics emitter seam for non-server-observable interactions in `frontend/lib/product-analytics.ts`
- [x] T040 [US4] Update operator docs in `docs/oss-saas-observability.md`, `docs/README.md`, `readme.md`, and any required settings docs once runtime behavior and config are final

**Checkpoint**: SaaS-only adapters are optional, isolated, and documented

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and documentation cleanup across all stories

- [x] T041 [P] Run targeted backend test suites covering telemetry, analytics, incidents, and runtime wiring
- [x] T042 [P] Validate `quickstart.md` scenarios against the implemented behavior
- [x] T043 Review cardinality, redaction, and failure-policy defaults across all observability sinks
- [x] T044 Review whether `readme.md` and `backend/.env.example` need additional operator guidance based on the final implementation slice

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on User Story 1 seams being available
- **User Story 3 (Phase 5)**: Depends on Foundational completion and should land before large fan-out across modules
- **User Story 4 (Phase 6)**: Depends on User Stories 1 and 2
- **Polish (Phase 7)**: Depends on all desired stories

### User Story Dependencies

- **User Story 1 (P1)**: First implementation slice and MVP
- **User Story 2 (P1)**: Builds on shared seams and first-party persistence
- **User Story 3 (P1)**: Can begin once foundational seams exist; should stay ahead of broad instrumentation work
- **User Story 4 (P2)**: Optional after the OSS default path is complete

### Within Each User Story

- Write backend tests and confirm they fail before implementation
- Add or extract focused modules before wiring orchestration
- Keep sink-specific integrations out of transport and domain orchestrators
- Finish redaction and correlation behavior before broad instrumentation fan-out
- Update docs in the same story when runtime behavior or config becomes operator-visible

### Parallel Opportunities

- Foundational helper tests and type-definition work marked `[P]`
- US1 telemetry and incident service modules in parallel
- US2 analytics and audit-backed sink modules in parallel
- US4 optional adapter implementations in parallel once default seams are stable

## Implementation Strategy

### MVP First

Deliver User Story 1 first: a first-party telemetry and incident-reporting path
that works with no external vendor. Then layer in the internal analytics model,
module-boundary cleanup, and optional SaaS-only adapters.
