# Tasks: Hybrid Retrieval

**Input**: Design documents from `/specs/009-hybrid-retrieval/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are required and must be written before implementation. Frontend verification follows the approved spec and quickstart.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare shared fixtures and confirm the feature scope against the existing retrieval/chat surfaces

- [x] T001 Review `/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/spec.md` and `/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/plan.md` against `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval`, `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/chat`, and `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard`
- [x] T002 [P] Add representative exact-match, mixed-signal, constraint-heavy, normalization, and legacy-chunk fixtures under `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/fixtures/retrieval-quality/`
- [x] T003 [P] Extend shared retrieval benchmark fixture builders in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/support/retrievalFixtures.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish shared schema, persistence, rollout safety, and retrieval seams before user story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 Write failing shared settings, chunk-persistence, and legacy-chunk compatibility tests in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/retrieval-settings-and-chunking.test.ts`
- [x] T005 [P] Add additive hybrid-retrieval schema fields and indexes in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/db/migrations/003_hybrid_retrieval.sql`
- [x] T006 [P] Extend retrieval-settings domain defaults and validation for attribute-family controls in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/settings/domain/retrievalSettings.ts`
- [x] T007 [P] Persist attribute-family controls in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/db/repositories/retrievalSettingsRepository.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/support/fakes.ts`
- [x] T008 [P] Extend chunk persistence records for `searchText` and structured attributes in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/documents/services/documentIngestionService.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/db/repositories/chunkRepository.ts`
- [x] T009 Extract hybrid retrieval types and seams in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts`, `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/candidatePreparationService.ts`, and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/app/server/dependencies.ts`
- [x] T010 Centralize hybrid retrieval defaults and thresholds in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/domain/hybridRetrievalConfig.ts`
- [x] T011 Implement backward-compatible handling for legacy chunks and document the reindex/backfill path in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/retrievalPipelineService.ts`, `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/infra/lexicalSearch.ts`, and `/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/quickstart.md`
- [x] T012 Wire the shared hybrid retrieval dependencies in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/app/server/dependencies.ts`, `/Users/dm/code/radioso-hybrid-retrieval/backend/src/app/server/types.ts`, and `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/support/testApp.ts`

**Checkpoint**: Shared schema, defaults, rollout safety, and retrieval seams are ready for story implementation

---

## Phase 3: User Story 1 - Retrieve exact and mixed-signal matches (Priority: P1) 🎯 MVP

**Goal**: Surface better candidates for exact-match and mixed semantic-plus-literal queries through hybrid semantic and lexical retrieval

**Independent Test**: Index representative documents, run exact-match and mixed-signal queries, and verify relevant cited sources are returned more reliably than with vector-only retrieval

### Tests for User Story 1

- [x] T013 [P] [US1] Write failing unit coverage for search-text rendering and lexical candidate mapping in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-retrieval-search.test.ts`
- [x] T014 [P] [US1] Write failing benchmark coverage for exact-match and mixed-signal retrieval in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/retrieval-benchmark.integration.test.ts`
- [x] T015 [P] [US1] Write failing integration coverage for hybrid candidate merging in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 1

- [x] T016 [US1] Implement normalized search-text rendering in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/searchTextRenderer.ts`
- [x] T017 [US1] Use normalized search text for embeddings during ingest in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/documents/services/documentIngestionService.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/embeddingService.ts`
- [x] T018 [US1] Implement PostgreSQL lexical search in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/infra/lexicalSearch.ts`
- [x] T019 [US1] Persist and read chunk `search_text` in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/db/repositories/chunkRepository.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/infra/vectorSearch.ts`
- [x] T020 [US1] Implement the explicit hybrid merge policy in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/candidatePreparationService.ts`
- [x] T021 [US1] Apply the merge policy with score fusion, source provenance retention, and merged candidate cap behavior in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [x] T022 [US1] Enrich rerank inputs with normalized retrieval text after lexical retrieval and merge behavior are validated in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/rerankService.ts`

**Checkpoint**: User Story 1 is functional and independently testable

---

## Phase 4: User Story 2 - Respect structured constraints safely (Priority: P2)

**Goal**: Parse supported query constraints and use normalized chunk attributes for safe hard filtering, boosting, and fallback behavior

**Independent Test**: Index supported attributes, run constraint-heavy queries, and verify high-confidence constraints narrow results correctly while low-confidence cases degrade to boosts or fallback behavior

### Tests for User Story 2

- [x] T023 [P] [US2] Write failing unit coverage for deterministic attribute extraction and normalization in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-attributes.test.ts`
- [x] T024 [P] [US2] Write failing unit coverage for query-constraint parsing and confidence thresholds in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-query-constraints.test.ts`
- [x] T025 [P] [US2] Write failing benchmark coverage for constraint-heavy retrieval and fallback in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/retrieval-benchmark.integration.test.ts`

### Implementation for User Story 2

- [x] T026 [US2] Implement raw supported-value extraction in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/structuredAttributeExtractor.ts`
- [x] T027 [US2] Implement family-specific canonicalization in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/attributeNormalizer.ts`
- [x] T028 [US2] Implement normalized structured-attribute models in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/domain/structuredAttributes.ts`
- [x] T029 [US2] Persist normalized structured attributes and concise attribute text during ingest in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/documents/services/documentIngestionService.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/db/repositories/chunkRepository.ts`
- [x] T030 [US2] Implement supported query-constraint interpretation in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/queryConstraintParser.ts`
- [x] T031 [US2] Implement attribute-to-constraint comparison, scoring, and fallback behavior in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/attributeMatchScoringService.ts`
- [x] T032 [US2] Apply parsed constraints and attribute scoring in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/retrievalPipelineService.ts`
- [x] T033 [US2] Include supported attributes in final prompt contexts in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/promptBuilder.ts`

**Checkpoint**: User Stories 1 and 2 are independently functional

---

## Phase 5: User Story 3 - Control supported attribute families per account (Priority: P3)

**Goal**: Let operators configure which supported attribute families are enabled and whether they act as boosts only or are eligible for hard filtering

**Independent Test**: Update settings for one account, reload them, and confirm the saved attribute-family controls apply only to that account’s future retrieval behavior

### Tests for User Story 3

- [x] T034 [P] [US3] Write failing contract coverage for attribute-family controls in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/contract/settings.contract.test.ts`
- [x] T035 [P] [US3] Write failing settings round-trip integration coverage for per-account attribute controls in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/document-settings.integration.test.ts`

### Implementation for User Story 3

- [x] T036 [US3] Accept and return attribute-family controls in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/app/http/routes/settingsRoutes.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/settings/services/retrievalSettingsService.ts`
- [x] T037 [US3] Extend frontend retrieval-settings types and payloads for attribute controls in `/Users/dm/code/radioso-hybrid-retrieval/frontend/lib/api.ts`
- [x] T038 [US3] Add supported attribute-family controls to `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard/settings-view.tsx`
- [x] T039 [US3] Add safe explanatory copy for system-defined attribute families in `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard/settings-view.tsx`
- [x] T040 [US3] Sync the retrieval-settings contract in `/Users/dm/code/radioso-hybrid-retrieval/backend/openapi.yaml` and `/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/contracts/hybrid-retrieval.openapi.yaml`

**Checkpoint**: User Stories 1, 2, and 3 are independently functional

---

## Phase 6: User Story 4 - Diagnose retrieval decisions (Priority: P3)

**Goal**: Capture and expose bounded retrieval diagnostics for executed queries without changing the core answer flow

**Independent Test**: Execute representative queries and verify parsed intent, candidate-source counts, applied constraints, rerank status, and fallback behavior are recorded and returned with the chat result

### Tests for User Story 4

- [x] T041 [P] [US4] Write failing unit coverage for retrieval diagnostics shaping in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-retrieval-info.test.ts`
- [x] T042 [P] [US4] Write failing chat contract coverage for additive `retrievalInfo` in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/contract/chat.contract.test.ts`
- [x] T043 [P] [US4] Write failing JSON and streaming retrieval-info coverage in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/chat-service-streaming.test.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/chat.integration.test.ts`

### Implementation for User Story 4

- [x] T044 [US4] Expand retrieval diagnostics models in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/domain/retrievalPipelineTypes.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/retrievalExecutionTelemetryService.ts`
- [x] T045 [US4] Implement bounded retrieval-information shaping in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/retrieval/services/retrievalInfoPresenter.ts`
- [x] T046 [US4] Attach retrieval information to chat results in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/chat/services/chatService.ts`
- [x] T047 [US4] Expose additive `retrievalInfo` payloads in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/app/http/presenters/chatPresenter.ts`
- [x] T048 [US4] Keep audit metadata aligned with hybrid diagnostics in `/Users/dm/code/radioso-hybrid-retrieval/backend/src/modules/audit/services/auditService.ts`

**Checkpoint**: User Stories 1 through 4 are independently functional

---

## Phase 7: User Story 5 - Review retrieval information in the admin UI (Priority: P3)

**Goal**: Show a bounded retrieval-information view in the admin chat experience so operators can inspect how a result set was produced

**Independent Test**: Run representative chat queries and verify the admin UI shows parsed intent, candidate-source counts, applied constraints, rerank status, and fallback usage for the corresponding answer

### Implementation for User Story 5

- [x] T049 [US5] Extend chat response and stream parsing for `retrievalInfo` in `/Users/dm/code/radioso-hybrid-retrieval/frontend/lib/api.ts` and `/Users/dm/code/radioso-hybrid-retrieval/frontend/lib/chat-context.tsx`
- [x] T050 [P] [US5] Create the retrieval-information panel component in `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard/chat-retrieval-info.tsx`
- [x] T051 [US5] Render bounded retrieval information in `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard/chat-view.tsx`
- [x] T052 [US5] Add readable copy and empty states for retrieval information in `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard/chat-retrieval-info.tsx`

**Checkpoint**: All user stories are independently functional

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final consistency, performance, rollout, and regression verification across stories

- [x] T053 [P] Refresh feature docs in `/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/quickstart.md` and `/Users/dm/code/radioso-hybrid-retrieval/specs/009-hybrid-retrieval/contracts/hybrid-retrieval.openapi.yaml` if implementation details drift
- [x] T054 Run affected backend unit, contract, integration, and benchmark suites in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/`
- [x] T055 Verify hybrid-path latency and benchmark deltas against the vector-only baseline in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/retrieval-benchmark.integration.test.ts`
- [x] T056 Verify rerank failure-path, lexical-search-disabled, and legacy-chunk regression behavior in `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/chat.integration.test.ts` and `/Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/retrieval-benchmark.integration.test.ts`
- [x] T057 Run targeted frontend verification for settings controls and retrieval-information rendering in `/Users/dm/code/radioso-hybrid-retrieval/frontend/components/dashboard/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational completion
- **User Story 2 (Phase 4)**: Depends on User Story 1 because supported constraints build on persisted `searchText`, lexical retrieval, merge policy, and merged hybrid candidates
- **User Story 3 (Phase 5)**: Depends on Foundational completion and can proceed after the shared settings seam exists
- **User Story 4 (Phase 6)**: Depends on User Stories 1 and 2 because diagnostics must describe the hybrid retrieval and constraint behavior actually implemented
- **User Story 5 (Phase 7)**: Depends on User Story 4 because the UI consumes additive retrieval-information payloads
- **Polish (Phase 8)**: Depends on all desired story work being complete

### User Story Dependencies

- **US1**: Independent after Foundational phase and is the suggested MVP slice
- **US2**: Depends on the hybrid candidate path from US1 but remains independently testable once those seams exist
- **US3**: Independent after Foundational phase and remains testable through retrieval-settings round trips
- **US4**: Depends on the hybrid retrieval and supported-constraint behavior from US1 and US2
- **US5**: Depends on additive `retrievalInfo` payloads from US4

### Within Each User Story

- Backend tests must be written and fail before implementation
- Migrations and persistence changes land before orchestration wiring that depends on them
- Focused retrieval modules land before `retrievalPipelineService.ts` or `chatService.ts` grows new behavior
- Settings persistence and validation land before route and frontend wiring
- Existing responsibility-limited files must stay transport-only or orchestration-only
- The extractor finds raw values, the normalizer canonicalizes them, the parser interprets query constraints, and the scorer compares parsed constraints against normalized attributes
- The admin UI must render bounded retrieval information rather than raw logs

### Parallel Opportunities

- T002 and T003 can run in parallel
- T005, T006, T007, and T008 can run in parallel after T004 exists
- T013, T014, and T015 can run in parallel
- T023, T024, and T025 can run in parallel
- T034 and T035 can run in parallel
- T041, T042, and T043 can run in parallel
- T050 can run in parallel with T049 once the response shape is agreed

---

## Parallel Example: User Story 1

```bash
Task: "Write failing unit coverage for search-text rendering and lexical candidate mapping in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-retrieval-search.test.ts"
Task: "Write failing benchmark coverage for exact-match and mixed-signal retrieval in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/retrieval-benchmark.integration.test.ts"
Task: "Write failing integration coverage for hybrid candidate merging in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/chat.integration.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Write failing unit coverage for deterministic attribute extraction and normalization in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-attributes.test.ts"
Task: "Write failing unit coverage for query-constraint parsing and confidence thresholds in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-query-constraints.test.ts"
Task: "Write failing benchmark coverage for constraint-heavy retrieval and fallback in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/retrieval-benchmark.integration.test.ts"
```

## Parallel Example: User Story 4

```bash
Task: "Write failing unit coverage for retrieval diagnostics shaping in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/hybrid-retrieval-info.test.ts"
Task: "Write failing chat contract coverage for additive retrievalInfo in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/contract/chat.contract.test.ts"
Task: "Write failing JSON and streaming retrieval-info coverage in /Users/dm/code/radioso-hybrid-retrieval/backend/tests/unit/chat-service-streaming.test.ts and /Users/dm/code/radioso-hybrid-retrieval/backend/tests/integration/chat.integration.test.ts"
```

---

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1
3. Validate exact-match and mixed-signal retrieval independently before layering in constraint logic

### Incremental Delivery

1. Add shared schema, thresholds, rollout safety, and retrieval seams
2. Add hybrid semantic-plus-lexical candidate generation and explicit merge policy
3. Add supported attribute extraction, normalization, and safe constraint handling
4. Add operator controls for supported attribute families
5. Add bounded diagnostics and retrieval-information UI
6. Run full backend and frontend verification with latency and regression checks

### Parallel Team Strategy

1. One engineer owns shared schema, defaults, and retrieval-settings persistence
2. One engineer owns retrieval-domain seams, lexical search, and candidate merging
3. One engineer owns supported attribute extraction, normalization, and scoring once the ingest seam exists
4. One engineer owns settings UI and retrieval-information UI after backend contracts stabilize

## Notes

- Total tasks: 57
- User story task counts: US1 = 10, US2 = 11, US3 = 7, US4 = 8, US5 = 4
- Suggested MVP scope: Phase 3 / User Story 1
- All tasks follow the required checklist format with task id, labels, and file paths
