# Tasks: OpenTelemetry Tracing

**Input**: Design documents from `/specs/080-opentelemetry-tracing/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Backend tests are required before implementation.

## Phase 1: Setup

**Purpose**: Add dependencies, configuration, and planning guardrails.

- [ ] T001 Add OpenTelemetry dependencies in `backend/package.json` and update `pnpm-lock.yaml`
- [ ] T002 Add tracing env validation and sampling fields in `backend/src/app/config/env.ts`
- [ ] T003 [P] Update `.env.example` or equivalent environment example with tracing settings

---

## Phase 2: Foundational

**Purpose**: Shared tracing substrate that blocks story work.

- [ ] T004 [P] Add failing tests for disabled tracing, enabled setup, sampling config, current correlation, and redaction in `backend/tests/unit/opentelemetry-tracing.test.ts`
- [ ] T005 [P] Add failing runtime config tests for `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` in `backend/tests/unit/runtime-config.test.ts`
- [ ] T006 Implement tracing lifecycle, no-op tracer, async-hooks context manager setup, span helpers, and current trace correlation in `backend/src/shared/observability/tracing/`
- [ ] T007 Implement privacy-safe trace attribute policy in `backend/src/shared/observability/tracing/`
- [ ] T008 Wire tracing lifecycle and runtime role metadata through `backend/src/app/composition/`, `backend/src/app/server/dependencyBuilders.ts`, and runtime startup/shutdown files
- [ ] T009 Run focused foundational tests: `cd backend && pnpm test -- tests/unit/opentelemetry-tracing.test.ts tests/unit/runtime-config.test.ts`

---

## Phase 3: User Story 1 - Enable Vendor-Neutral Backend Tracing (Priority: P1)

**Goal**: Operators can enable backend tracing and export a basic API trace without changing product behavior when disabled.

**Independent Test**: Enable tracing against a local collector or in-memory exporter test and verify a basic API request emits safe service/route/status metadata.

- [ ] T010 [P] [US1] Add failing API tracing middleware tests in `backend/tests/unit/opentelemetry-http.test.ts`
- [ ] T011 [US1] Add API request span middleware or integrate auto-instrumentation setup in `backend/src/app/server/createApp.ts` using shared tracing helpers
- [ ] T012 [US1] Add shutdown flush coverage for API and worker runtime handles in `backend/tests/unit/runtime-startup.test.ts`
- [ ] T013 [US1] Verify existing metrics and telemetry tests still pass with tracing disabled in `backend/tests/unit/telemetry-service.test.ts`

---

## Phase 4: User Story 2 - Diagnose Chat And Retrieval Latency (Priority: P1)

**Goal**: Retrieval-backed chat turns expose nested chat, retrieval, stage, and provider spans and debug-only product correlation.

**Independent Test**: Run representative chat/retrieval unit coverage and verify parent-child spans plus optional turn trace correlation.

- [ ] T014 [P] [US2] Add failing turn trace envelope tests for optional OpenTelemetry correlation in `backend/tests/unit/turn-trace-envelope.test.ts`
- [ ] T015 [P] [US2] Add failing retrieval span hierarchy tests in `backend/tests/unit/retrieval-pipeline-stages.test.ts` or a focused tracing test
- [ ] T016 [US2] Add optional debug-only OpenTelemetry correlation to chat turn trace envelope types and mappers in `backend/src/modules/chat/services/turnTraceEnvelope.ts`
- [ ] T017 [US2] Update code-first debug schemas in `backend/src/app/http/openapi/schemas/assistantHistorySchemas.ts` and regenerate OpenAPI artifacts through the existing script if affected
- [ ] T018 [US2] Add chat answer and streaming spans in `backend/src/modules/chat/services/`
- [ ] T019 [US2] Add retrieval pipeline and stage spans with bounded attributes in `backend/src/modules/retrieval/services/`
- [ ] T020 [US2] Add semantic provider spans for LLM and embedding calls while keeping outbound HTTP spans as transport children or links in provider adapter files

---

## Phase 5: User Story 3 - Trace Asynchronous Document And Crawler Work (Priority: P2)

**Goal**: Document and crawler jobs emit safe spans for dispatch, processing, retries, completion, and failures.

**Independent Test**: Run document worker tests and verify job/document correlation and stage spans without changing durable job semantics.

- [ ] T021 [P] [US3] Add failing document worker tracing tests in `backend/tests/unit/document-processing-worker-runtime.test.ts`
- [ ] T022 [P] [US3] Add message-queue impact review notes to `specs/080-opentelemetry-tracing/plan.md`
- [ ] T023 [US3] Add document processing worker and processing service spans in `backend/src/modules/documents/services/`
- [ ] T024 [US3] Add crawler worker spans in `backend/src/modules/websiteCrawler/`
- [ ] T025 [US3] Add connector fetch/sync/webhook spans with safe attributes in `backend/src/modules/connectors/`

---

## Phase 6: User Story 4 - Correlate Logs, Metrics, Traces, And Audit Events (Priority: P2)

**Goal**: Existing observability surfaces remain independent but share safe correlation identifiers.

**Independent Test**: Trigger request/job paths in tests and verify trace ids/log correlation are present where safe while metrics stay low-cardinality.

- [ ] T026 [P] [US4] Add failing tests for trace/span id log enrichment in `backend/tests/unit/telemetry-service.test.ts` or focused logging tests
- [ ] T027 [US4] Add safe trace/span identifiers to structured logs where useful in `backend/src/shared/observability/logger.ts`
- [ ] T028 [US4] Verify metrics labels do not include trace ids or high-cardinality content in `backend/tests/unit/retrieval-execution-telemetry-service.test.ts`

---

## Phase 7: User Story 5 - Operate Tracing Safely In Production (Priority: P3)

**Goal**: Operators can enable, sample, troubleshoot, and validate tracing safely.

**Independent Test**: Follow quickstart to observe one API trace and one worker trace, and run redaction/performance checks.

- [ ] T029 [P] [US5] Add redaction tests for prohibited trace attributes in `backend/tests/unit/opentelemetry-tracing.test.ts`
- [ ] T030 [P] [US5] Add benchmark or focused overhead check for representative chat/retrieval and document-processing flows under tracing in `backend/tests/integration/retrieval-benchmark.integration.test.ts` or a performance script
- [ ] T031 [US5] Update `docs/oss-saas-observability.md` with tracing setup, local collector example, sampling, privacy exclusions, troubleshooting, and expected trace shapes
- [ ] T032 [US5] Update `readme.md` if tracing changes common operator setup
- [ ] T033 [US5] Validate quickstart commands from `specs/080-opentelemetry-tracing/quickstart.md`

---

## Phase 8: Polish & Review

- [ ] T034 Run focused backend tests for tracing, chat envelope, retrieval, document worker, runtime config, and telemetry
- [ ] T035 Run `cd backend && pnpm run build`
- [ ] T036 Run `pnpm run ci:local -- origin/main` or document why it was not run
- [ ] T037 Request senior engineer review and address feedback
- [ ] T038 Request engineering manager review and address feedback
- [ ] T039 Create PR with summary, tests, issue #631, and links to Speckit artifacts

## Dependencies & Execution Order

- Phase 1 and Phase 2 block all span instrumentation.
- US1 and US2 are both P1; US2 depends on the foundational tracing helper but can proceed in parallel with US1 after Phase 2.
- US3 depends on the foundational helper and can proceed in parallel with US2 once the helper is stable.
- US4 depends on trace correlation helper availability.
- US5 documentation can begin after config and expected trace shapes stabilize.

## Parallel Opportunities

- T003, T004, and T005 can run in parallel.
- US2 debug contract tests and retrieval span tests can run in parallel.
- US3 document, crawler, and connector spans can be split by module once the helper exists.
- Docs can run in parallel after config names and quickstart shape are final.

## Implementation Strategy

1. Deliver foundational tracing substrate first.
2. Deliver MVP API tracing and disabled/no-op behavior.
3. Add chat/retrieval/provider spans and debug correlation.
4. Add worker/crawler/connector coverage.
5. Finish docs, overhead checks, review, and PR.
