# Tasks: Date-Aware Event Retrieval via Shape-Aware Ingestion Enrichment

**Input**: Design documents from `/specs/099-date-aware-event-retrieval/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/http-contract-notes.md`, `quickstart.md`

**Tests**: Backend tests are required and appear before implementation tasks.
Frontend user-visible flows use Playwright first; frontend unit tests are only
for API adapter/settings serialization logic.

**Organization**: Tasks are grouped by user story in approved priority order:
P1 stories 1 and 2 first, then stories 3, 4, and 5.

## Phase 1: Setup (Shared Planning Baseline)

**Purpose**: Establish the shared implementation scaffolding and contract anchors.

- [X] T001 Confirm next migration number and record it for feature 099 in `backend/src/db/migrations/`
- [X] T002 [P] Create enrichment prompt directory target `backend/prompts/ingestion/`
- [X] T003 [P] Create document enrichment domain directory target `backend/src/modules/documents/domain/enrichment/`
- [X] T004 [P] Create retrieval temporal domain directory target `backend/src/modules/retrieval/domain/temporal/`
- [X] T005 [P] Create retrieval temporal service directory target `backend/src/modules/retrieval/services/temporal/`
- [X] T006 [P] Create temporal eval fixture target directory `backend/tests/fixtures/event-retrieval/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core seams and schema changes that must exist before any story implementation.

**Critical**: No user story work starts until this phase is complete.

- [ ] T007 [P] Write migration test expectations for enrichment columns and generated chunk date columns in `backend/tests/integration/document-repository.integration.test.ts`
- [ ] T008 [P] Write processing job options repository tests in `backend/tests/integration/document-processing-job-repository.integration.test.ts`
- [ ] T009 [P] Write chunk temporal generated-column repository tests in `backend/tests/integration/document-chunking.integration.test.ts`
- [X] T010 Add migration for ingestion setting, document enrichment provenance, source config support, job options, and chunk date generated columns in `backend/src/db/migrations/119_date_aware_event_retrieval.sql`
- [X] T011 Update generated schema type expectations for new columns in `backend/src/shared/infra/kysely/schema.ts`
- [X] T012 Update schema snapshot for new tables/columns/indexes in `backend/src/db/schema.sql`
- [X] T013 Update document row mapping types for enrichment provenance in `backend/src/db/repositories/documentRowMapper.ts`
- [X] T014 Update document contracts for enrichment provenance and chunk metadata/date fields in `backend/src/modules/documents/contracts/index.ts`
- [X] T015 Update `DocumentProcessingJobRecord` and repository column mapping for nullable options in `backend/src/db/repositories/documentProcessingJobRepository.ts`
- [X] T016 Update chunk persistence and detail projection for generated temporal columns in `backend/src/modules/documents/infra/chunkRepository.ts`
- [X] T017 Update vector chunk storage insert path to preserve final chunk metadata in `backend/src/modules/retrieval/infra/chunkVectorStorage.ts`
- [X] T018 Update OpenAPI schema catalog for document provenance and reprocess option shared schemas in `backend/src/app/http/openapi/openApiRegistry.ts`
- [X] T019 Re-check queue message compatibility and keep `documentJobQueueMessageSchema` unchanged in `backend/src/modules/documents/services/documentJobMessage.ts`

**Run-scope deviation**: T007-T009 remain unchecked because this run explicitly
disallows Postgres-backed integration tests. Equivalent foundational coverage in
this slice is unit-level: enrichment schema/strategy/service tests plus AMQP
queue compatibility, with migration/schema changes implemented for later
integration verification.

**Checkpoint**: Schema, job options, per-chunk metadata, and contract anchors are ready for user stories.

---

## Phase 3: User Story 1 - Shape-aware ingestion enrichment with temporal extraction (Priority: P1) MVP

**Goal**: Enriched document processing classifies shape, extracts supported temporal facts in one model call, applies document/chunk metadata, and fails open with observable provenance.

**Independent Test**: Ingest an event fixture with the date in a separate paragraph, verify event chunks carry `dateFrom`/`dateTo`, and verify chat answers the date from grounded evidence.

### Tests for User Story 1

- [X] T020 [P] [US1] Write document enrichment contract validation tests in `backend/tests/unit/document-enrichment-contract.test.ts`
- [X] T021 [P] [US1] Write enrichment enablement resolver tests for workspace/source/job precedence in `backend/tests/unit/document-enrichment-enablement.test.ts`
- [X] T022 [P] [US1] Write event strategy chunk-overlap metadata tests in `backend/tests/unit/document-enrichment-strategies.test.ts`
- [X] T023 [P] [US1] Write article/profile/generic strategy tests in `backend/tests/unit/document-enrichment-strategies.test.ts`
- [X] T024 [P] [US1] Write single-call enrichment service tests with mocked LLM output in `backend/tests/unit/document-enrichment-service.test.ts`
- [ ] T025 [P] [US1] Write document processing enrichment integration tests in `backend/tests/integration/document-chunking.integration.test.ts`
- [ ] T026 [P] [US1] Write enrichment failure processing tests in `backend/tests/unit/document-processing-worker-error-reporting.test.ts`
- [ ] T027 [P] [US1] Write grounded chat date-answer fixture test in `backend/tests/integration/retrieval-answer.integration.test.ts`

**Run-scope deviation**: T025 and T027 remain unchecked because this run
explicitly disallows Postgres-backed integration tests. T026 remains unchecked
because the existing processor unit test import path is blocked in this sandbox
by unresolved local workspace packages (`@radioso/conversation-defaults`), which
also blocks collecting `document-subject-search-text.test.ts`; the enrichment
service fail-open path is unit-tested in `document-enrichment-service.test.ts`.

### Implementation for User Story 1

- [X] T028 [P] [US1] Define `DocumentShape` and enrichment Zod output schemas in `backend/src/modules/documents/domain/enrichment/documentEnrichmentContract.ts`
- [X] T029 [P] [US1] Implement enrichment enablement resolver in `backend/src/modules/documents/domain/enrichment/enrichmentEnablement.ts`
- [X] T030 [P] [US1] Implement character-range overlap and metadata patch helpers in `backend/src/modules/documents/domain/enrichment/chunkMetadataPatches.ts`
- [X] T031 [P] [US1] Implement event/article/profile/reference/generic strategy port and registry in `backend/src/modules/documents/domain/enrichment/enrichmentStrategies.ts`
- [X] T032 [US1] Add runtime enrichment prompt in `backend/prompts/ingestion/document-enrichment.md`
- [X] T033 [US1] Implement bounded document representation and single-call gateway orchestration in `backend/src/modules/documents/services/documentEnrichmentService.ts`
- [X] T034 [US1] Export enrichment service and strategy registry from `backend/src/modules/documents/composition.ts`
- [X] T035 [US1] Wire enrichment service and default strategy registry in `backend/src/app/server/dependencyBuilders.ts`
- [X] T036 [US1] Add enrichment stage call and per-chunk final metadata/search-text rendering in `backend/src/modules/documents/services/documentProcessingService.ts`
- [X] T037 [US1] Persist enrichment provenance without changing document failure fields in `backend/src/db/repositories/documentRepository.ts`
- [X] T038 [US1] Record enrichment audit events without raw document content in `backend/src/modules/documents/services/documentProcessingService.ts`
- [X] T039 [US1] Add enrichment span/log attributes with safe fields in `backend/src/modules/documents/services/documentProcessingService.ts`
- [X] T040 [US1] Present document enrichment provenance in `backend/src/app/http/routes/documentRoutes.ts`
- [X] T041 [US1] Register document detail enrichment schema in `backend/src/app/http/openapi/paths/documentsPaths.ts`

**Code-reality deviation**: T040 is satisfied through the existing document
detail route returning `DocumentIngestionService.getDocument()`, after adding
`enrichment` to document summaries/details. T041 is satisfied in the current
code-first owner `backend/src/app/http/openapi/schemas/documentRetrievalSchemas.ts`
and catalog registration, not a separate `paths/documentsPaths.ts` edit.

**Checkpoint**: User Story 1 is independently functional and testable.

---

## Phase 4: User Story 2 - Enrichment control per workspace, source, and reprocess (Priority: P1)

**Goal**: Operators control enrichment at workspace, source, and reprocess-run level, and can reprocess one source without touching other sources.

**Independent Test**: Toggle enrichment on for one source, reprocess that source, and verify only that source's documents are enriched while another source is untouched.

### Tests for User Story 2

- [ ] T042 [P] [US2] Write ingestion settings default/update tests for `documentEnrichmentEnabled` in `backend/tests/unit/ingestion-settings.test.ts`
- [ ] T043 [P] [US2] Write ingestion settings repository tests for enrichment default persistence in `backend/tests/integration/document-settings.integration.test.ts`
- [ ] T044 [P] [US2] Write document source override repository tests in `backend/tests/integration/document-source-repository.integration.test.ts`
- [ ] T045 [P] [US2] Write single-document reprocess override tests in `backend/tests/unit/document-ingestion.test.ts`
- [ ] T046 [P] [US2] Write per-source reprocess service tests in `backend/tests/unit/document-source-reprocess-service.test.ts`
- [ ] T047 [P] [US2] Write per-source reprocess integration tests in `backend/tests/integration/document-repository.integration.test.ts`
- [ ] T048 [P] [US2] Write document/settings contract tests for new fields/endpoints in `backend/tests/contract/document.contract.test.ts`
- [ ] T049 [P] [US2] Write settings contract tests for ingestion enrichment field and workspace override body in `backend/tests/contract/settings.contract.test.ts`
- [ ] T050 [P] [US2] Write Playwright coverage for ingestion toggle and source reprocess controls in `frontend/tests/e2e/source-detail.spec.ts`
- [ ] T051 [P] [US2] Write frontend API adapter unit tests for reprocess overrides in `frontend/tests/unit/document-enrichment-api.test.ts`
- [ ] T052 [P] [US2] Write MCP reprocess override tests in `packages/radioso-mcp-server/tests/writeTools.test.ts`

### Implementation for User Story 2

- [ ] T053 [US2] Add `documentEnrichmentEnabled` to ingestion settings domain defaults and validation in `backend/src/modules/settings/domain/ingestionSettings.ts`
- [ ] T054 [US2] Persist `documentEnrichmentEnabled` in `backend/src/db/repositories/ingestionSettingsRepository.ts`
- [ ] T055 [US2] Expose ingestion enrichment field in settings service contracts in `backend/src/modules/settings/contracts/ingestion.ts`
- [ ] T056 [US2] Add ingestion settings route validation for enrichment field in `backend/src/app/http/routes/settingsRouteSchemas.ts`
- [ ] T057 [US2] Add source enrichment override parsing and presenter support in `backend/src/app/http/presenters/documentSourcePresenter.ts`
- [ ] T058 [US2] Extend source update schema for enrichment override in `backend/src/app/http/routes/documentRouteSchemas.ts`
- [ ] T059 [US2] Persist source enrichment override through source config updates in `backend/src/db/repositories/documentSourceRepository.ts`
- [ ] T060 [US2] Add optional reprocess override body to single-document route in `backend/src/app/http/routes/documentRoutes.ts`
- [ ] T061 [US2] Add workspace reprocess override body to settings route in `backend/src/app/http/routes/settingsRoutes.ts`
- [ ] T062 [US2] Add per-source reprocess service in `backend/src/modules/documents/services/documentSourceReprocessService.ts`
- [ ] T063 [US2] Add source-scoped requeue repository method in `backend/src/db/repositories/documentRepository.ts`
- [ ] T064 [US2] Wire source reprocess service into route dependencies in `backend/src/app/server/types.ts`
- [ ] T065 [US2] Add `POST /document/sources/{sourceId}/reprocess` route in `backend/src/app/http/routes/documentRoutes.ts`
- [ ] T066 [US2] Update OpenAPI documents paths for source reprocess and reprocess override bodies in `backend/src/app/http/openapi/paths/documentsPaths.ts`
- [ ] T067 [US2] Update OpenAPI settings schemas/paths for ingestion enrichment and workspace reprocess body in `backend/src/app/http/openapi/schemas/settingsSchemas.ts`
- [ ] T068 [US2] Update frontend API types through generated contract use in `frontend/lib/api-types.ts`
- [ ] T069 [US2] Add frontend ingestion enrichment toggle in `frontend/components/dashboard/settings/ingestion-settings-panel.tsx`
- [ ] T070 [US2] Add source override and reprocess source controls in `frontend/components/dashboard/document-sources-view.tsx`
- [ ] T071 [US2] Show document enrichment provenance/failure state in `frontend/components/dashboard/documents/document-editor-page.tsx`
- [ ] T072 [US2] Add API adapter methods for reprocess overrides in `frontend/lib/api-documents.ts`
- [ ] T073 [US2] Add SDK convenience methods for source/document reprocess overrides in `typescript-sdk/src/index.ts`
- [ ] T074 [US2] Add MCP `reprocess_document` enrichment override support in `packages/radioso-mcp-server/src/tools/writeTools.ts`
- [ ] T075 [US2] Update MCP API adapter request body support in `packages/radioso-mcp-server/src/radiosoApiAdapter.ts`

**Checkpoint**: User Stories 1 and 2 work independently.

---

## Phase 5: User Story 3 - "What are the next events?" returns upcoming events in order (Priority: P2)

**Goal**: Anchorless upcoming-event queries use temporal candidates, exclude past events, and stage upcoming events soonest-first behind per-agent settings.

**Independent Test**: Against an enriched corpus with past and future events, ask "what are the next events?" and verify future-only, soonest-first evidence; disabling each temporal setting deactivates its behavior.

### Tests for User Story 3

- [ ] T076 [P] [US3] Write query rewrite parser tests for `temporalQueryMode` in `backend/tests/unit/query-rewrite-port.test.ts`
- [ ] T077 [P] [US3] Write temporal candidate repository tests with fixed today in `backend/tests/integration/retrieval-temporal-candidates.integration.test.ts`
- [ ] T078 [P] [US3] Write candidate merge/dedupe tests for temporal candidates in `backend/tests/unit/temporal-candidate-merge.test.ts`
- [ ] T079 [P] [US3] Write retrieval settings drift tests for temporal fields in `backend/tests/unit/retrieval-skill-settings-drift.test.ts`
- [ ] T080 [P] [US3] Write retrieval pipeline tests for next-events listing mode in `backend/tests/unit/retrieval-pipeline-stages.test.ts`
- [ ] T081 [P] [US3] Write Playwright coverage for three temporal toggles in `frontend/tests/e2e/assistant-retrieval-settings.spec.ts`
- [ ] T082 [P] [US3] Write frontend retrieval skill settings unit tests for temporal fields in `frontend/tests/unit/retrieval-skill-settings.test.ts`

### Implementation for User Story 3

- [ ] T083 [US3] Extend structured rewrite types with temporal query mode in `backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [ ] T084 [US3] Update query rewrite parser for `temporalQueryMode` in `backend/src/modules/retrieval/services/queryRewriteParser.ts`
- [ ] T085 [US3] Update query rewrite prompt blueprint without English keyword rules in `backend/prompts/retrieval/query-rewrite.md`
- [ ] T086 [US3] Add temporal candidate retrieval port in `backend/src/modules/retrieval/domain/temporal/temporalCandidateRetrieval.ts`
- [ ] T087 [US3] Implement Postgres temporal candidate adapter in `backend/src/modules/retrieval/infra/temporalCandidateRepository.ts`
- [ ] T088 [US3] Wire temporal candidate adapter in `backend/src/modules/retrieval/composition.ts`
- [ ] T089 [US3] Extend candidate retrieval stage to request temporal candidates in listing mode in `backend/src/modules/retrieval/services/candidateRetrievalStage.ts`
- [ ] T090 [US3] Extend candidate source typing for temporal candidates in `backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`
- [ ] T091 [US3] Merge and dedupe temporal candidates with semantic/lexical candidates in `backend/src/modules/retrieval/services/temporal/temporalCandidateMergeService.ts`
- [ ] T092 [US3] Implement upcoming boost as retrieval-owned scoring helper in `backend/src/modules/retrieval/services/temporal/upcomingBoostService.ts`
- [ ] T093 [US3] Apply upcoming boost behind setting in `backend/src/modules/retrieval/services/candidatePreparationStage.ts`
- [ ] T094 [US3] Add temporal settings defaults in `backend/src/modules/settings/domain/retrievalSettings.ts`
- [ ] T095 [US3] Add temporal settings override schema support in `backend/src/modules/retrieval/domain/retrievalSkillSettings.ts`
- [ ] T096 [US3] Update retrieval skill manifest contract fields in `backend/src/modules/skills/definitions/retrieval.answer/generated.contract.json`
- [ ] T097 [US3] Update frontend retrieval skill settings serialization in `frontend/lib/retrieval-skill-settings.ts`
- [ ] T098 [US3] Add temporal switches to retrieval settings UI in `frontend/components/dashboard/settings/workspace-assistant-channels-tab.tsx`
- [ ] T099 [US3] Add temporal retrieval trace fields in `backend/src/modules/retrieval/services/retrievalActivityTraceAssembler.ts`
- [ ] T100 [US3] Surface temporal candidate counts in activity trace presenter in `frontend/components/dashboard/activity-trace-detail.tsx`

**Checkpoint**: User Story 3 works with enriched metadata and per-agent toggles.

---

## Phase 6: User Story 4 - "Sort events by actuality" is deterministic (Priority: P3)

**Goal**: Date-shaped event lookup context is ordered deterministically by event dates when enabled.

**Independent Test**: Repeat sort-by-actuality queries and verify identical date-ordered staged evidence with deterministic sort enabled.

### Tests for User Story 4

- [ ] T101 [P] [US4] Write deterministic temporal ordering unit tests in `backend/tests/unit/temporal-context-ordering.test.ts`
- [ ] T102 [P] [US4] Write repeated-run retrieval integration test for actuality sort in `backend/tests/integration/retrieval-answer.integration.test.ts`

### Implementation for User Story 4

- [ ] T103 [US4] Implement temporal context ordering helper in `backend/src/modules/retrieval/services/temporal/temporalContextOrdering.ts`
- [ ] T104 [US4] Apply deterministic ordering after rerank and before prompt selection in `backend/src/modules/retrieval/services/contextSelectionStage.ts`
- [ ] T105 [US4] Include deterministic ordering status in retrieval diagnostics in `backend/src/modules/retrieval/services/retrievalDiagnosticsStage.ts`
- [ ] T106 [US4] Include temporal order evidence in activity trace summary in `backend/src/modules/retrieval/services/retrievalPipelineActivityTraceBuilder.ts`
- [ ] T107 [US4] Confirm disabling deterministic sort restores model/rerank order in `backend/src/modules/retrieval/services/contextSelectionStage.ts`

**Checkpoint**: User Story 4 works repeatedly and can be disabled per agent.

---

## Phase 7: User Story 5 - Workbench eval coverage for event queries (Priority: P3)

**Goal**: Workbench eval cases measure dated evidence and ordering against deterministic enriched fixtures.

**Independent Test**: Run event-query eval cases against the fixture corpus and verify pass/fail reflects expected dated outcomes.

### Tests for User Story 5

- [ ] T108 [P] [US5] Write enriched event fixture seed tests in `backend/tests/unit/eval-suite.test.ts`
- [ ] T109 [P] [US5] Write workbench replay tests for event query eval outcomes in `backend/tests/unit/workbench-replay-runner.test.ts`
- [ ] T110 [P] [US5] Write frontend workbench seed unit tests for event cases in `frontend/tests/unit/eval-workbench-seed.test.ts`
- [ ] T111 [P] [US5] Write Playwright workbench eval coverage for event suite in `frontend/tests/e2e/workbench-replay.spec.ts`

### Implementation for User Story 5

- [ ] T112 [US5] Add deterministic enriched corpus fixtures in `backend/tests/fixtures/event-retrieval/event-corpus.ts`
- [ ] T113 [US5] Add named-event date eval case definitions in `backend/tests/fixtures/event-retrieval/event-eval-cases.ts`
- [ ] T114 [US5] Add next-events and actuality-sort assertions in `backend/src/modules/chat/services/workbenchReplayRunner.ts`
- [ ] T115 [US5] Expose event eval seed option in `frontend/lib/eval-workbench-seed.ts`
- [ ] T116 [US5] Render event eval cases in workbench UI in `frontend/components/dashboard/eval-view.tsx`

**Checkpoint**: User Story 5 provides deterministic regression coverage.

---

## Final Phase: Polish & Cross-Cutting Concerns

**Purpose**: Generated contracts, documentation parity, and validation planning.

- [ ] T117 Regenerate backend OpenAPI outputs from code-first registry in `backend/openapi.yaml`
- [ ] T118 Regenerate backend OpenAPI JSON from code-first registry in `backend/openapi.json`
- [ ] T119 Sync TypeScript SDK OpenAPI snapshots and generated client in `typescript-sdk/src/generated/client.ts`
- [ ] T120 Sync TypeScript SDK generated types in `typescript-sdk/src/generated/types.ts`
- [ ] T121 Sync MCP generated OpenAPI types in `packages/radioso-mcp-server/src/generated/openapiTypes.ts`
- [ ] T122 [P] Update ingestion settings docs in `docs/settings-docs/ingestion/reprocess-existing-documents.md`
- [ ] T123 [P] Add mirrored frontend ingestion enrichment setting docs in `frontend/docs/settings-docs/ingestion/document-enrichment.md`
- [ ] T124 [P] Add retrieval temporal setting docs in `docs/settings-docs/retrieval/temporal-structured-lookup.md`
- [ ] T125 [P] Add mirrored frontend retrieval temporal setting docs in `frontend/docs/settings-docs/retrieval/temporal-structured-lookup.md`
- [ ] T126 [P] Update source/reprocess docs in `docs-portal/content/operators/document-processing.mdx`
- [ ] T127 [P] Update API docs for document/source/settings contracts in `docs-portal/content/api/documents-and-search.mdx`
- [ ] T128 [P] Update settings API docs in `docs-portal/content/api/settings.mdx`
- [ ] T129 [P] Update retrieval architecture docs in `docs-portal/content/architecture/retrieval-pipeline.mdx`
- [ ] T130 [P] Update document processing lifecycle docs in `docs-portal/content/architecture/document-processing-lifecycle.mdx`
- [ ] T131 [P] Update SDK docs in `docs/typescript-sdk-basic-usage.md`
- [ ] T132 [P] Update MCP docs for `reprocess_document` override in `docs/mcp-client-setup.md`
- [ ] T133 [P] Update package MCP README in `packages/radioso-mcp-server/README.md`
- [ ] T134 [P] Update repository overview for new ingestion/retrieval settings in `readme.md`
- [ ] T135 Verify generated contract drift checks are covered by `backend/tests/contract/sdk-openapi.contract.test.ts`
- [ ] T136 Verify no queue message schema change by reviewing `backend/tests/unit/amqp-document-job-queue.test.ts`
- [ ] T137 Document validation commands and any skipped commands in PR notes using `specs/099-date-aware-event-retrieval/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**: no dependencies.
- **Phase 2 Foundational**: depends on Phase 1 and blocks all user stories.
- **US1 and US2 (P1)**: start after Phase 2. US2 can build controls in parallel with US1 domain work, but end-to-end enrichment verification depends on US1.
- **US3 (P2)**: depends on US1 metadata and US2 per-agent setting surfaces.
- **US4 (P3)**: depends on US3 temporal candidates/settings.
- **US5 (P3)**: depends on US1, US3, and US4 behavior.
- **Final Phase**: after user stories whose contracts/docs changed.

### User Story Dependencies

- **US1**: depends only on foundational schema/seams.
- **US2**: depends on job options and enablement resolver; integrates with US1 for full enrichment effect.
- **US3**: depends on chunk `dateFrom`/`dateTo` metadata from US1.
- **US4**: depends on US3 query mode and temporal candidates.
- **US5**: depends on all behavior it evaluates.

### Backend TDD Rule

For every backend behavior change in a story, complete that story's backend test
tasks first and confirm they fail before implementing the matching production
tasks.

---

## Parallel Opportunities

- Phase 1 directory/setup tasks T002-T006 can run in parallel.
- Foundational tests T007-T009 can run in parallel.
- US1 test tasks T020-T027 can run in parallel before US1 implementation.
- US2 backend contract/repository/service tests T042-T049 can run in parallel with frontend/MCP tests T050-T052.
- US3 tests T076-T082 can run in parallel.
- Docs tasks T122-T134 can run in parallel after implementation decisions are stable.

## Parallel Example: User Story 1

```bash
Task: "T020 Write document enrichment contract validation tests in backend/tests/unit/document-enrichment-contract.test.ts"
Task: "T021 Write enrichment enablement resolver tests in backend/tests/unit/document-enrichment-enablement.test.ts"
Task: "T022 Write event strategy chunk-overlap metadata tests in backend/tests/unit/document-enrichment-strategies.test.ts"
Task: "T024 Write single-call enrichment service tests with mocked LLM output in backend/tests/unit/document-enrichment-service.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T048 Write document/settings contract tests for new fields/endpoints in backend/tests/contract/document.contract.test.ts"
Task: "T050 Write Playwright coverage for ingestion toggle and source reprocess controls in frontend/tests/e2e/source-detail.spec.ts"
Task: "T052 Write MCP reprocess override tests in packages/radioso-mcp-server/tests/writeTools.test.ts"
```

## Implementation Strategy

### MVP First

1. Complete Phase 1 and Phase 2.
2. Complete US1.
3. Validate chunk metadata/search text, enrichment provenance, and one grounded date-answer fixture.
4. Stop if US1 changes require spec clarification.

### Incremental Delivery

1. US1: enrichment and per-chunk metadata.
2. US2: controls and reprocess actions.
3. US3: next-events temporal retrieval.
4. US4: deterministic actuality sorting.
5. US5: eval coverage.
6. Final: generated contracts and docs parity.

### Validation Plan

Do not run validation in the planning phase. During implementation, use focused
Vitest/Playwright/contract checks per story, then local CI before PR.
