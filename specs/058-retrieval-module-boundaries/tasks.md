# Tasks: Retrieval Module Boundaries

**Input**: Design documents from `/specs/058-retrieval-module-boundaries/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/retrieval-public-surface.md, quickstart.md

**Tests**: Backend TDD is required. Add boundary enforcement first, validate it fails against the current direct imports, then migrate imports to make it pass.

**Organization**: Tasks are grouped by user story so the retrieval public-surface pilot can be validated incrementally.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add the boundary validation tool and local scripts.

- [X] T001 Add dependency-cruiser as a backend dev dependency in backend/package.json and backend/package-lock.json
- [X] T002 Add backend/dependency-cruiser.config.cjs with a retrieval internal import rule scoped to backend production source
- [X] T003 Add lint:boundaries and lint scripts in backend/package.json
- [X] T004 Run cd backend && npm run lint:boundaries and record the expected red failure from existing direct retrieval-internal imports

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the public surface before production consumers migrate to it.

- [X] T005 Create curated retrieval exports in backend/src/modules/retrieval/public.ts
- [X] T006 Run cd backend && npm run build to verify the new public surface compiles before import migration

**Checkpoint**: Public entrypoint exists and compiles.

---

## Phase 3: User Story 1 - Depend On Retrieval Through One Public Surface (Priority: P1) MVP

**Goal**: Production consumers outside retrieval import retrieval-owned symbols through `backend/src/modules/retrieval/public.ts`.

**Independent Test**: `cd backend && npm run lint:boundaries` passes once imports are migrated.

### Tests for User Story 1

- [X] T007 [US1] Run cd backend && npm run lint:boundaries and confirm it still fails before production import migration

### Implementation for User Story 1

- [X] T008 [US1] Migrate app composition and app server retrieval imports in backend/src/app/composition/defaultComposition.ts, backend/src/app/server/dependencies.ts, and backend/src/app/server/types.ts
- [X] T009 [US1] Migrate app HTTP retrieval imports in backend/src/app/http/openapi/document.ts, backend/src/app/http/presenters/chatPresenter.ts, backend/src/app/http/routes/retrievalRoutes.ts, and backend/src/app/http/routes/settingsRoutes.ts
- [X] T010 [US1] Migrate chat module retrieval imports in backend/src/modules/chat/services/*.ts and backend/src/modules/chat/types/chatResponses.ts
- [X] T011 [US1] Migrate document module retrieval imports in backend/src/modules/documents/services/documentIngestionService.ts, backend/src/modules/documents/services/documentProcessingService.ts, backend/src/modules/documents/services/documentSearchService.ts, and backend/src/modules/documents/services/documentSearchHistoryService.ts
- [X] T012 [US1] Migrate settings, audit, and shared LLM retrieval imports in backend/src/modules/settings/domain/ingestionSettings.ts, backend/src/modules/audit/services/auditService.ts, and backend/src/shared/infra/llm/providerRegistry.ts
- [X] T013 [US1] Run cd backend && npm run lint:boundaries and confirm the boundary rule passes

**Checkpoint**: Retrieval internals are private to external production consumers.

---

## Phase 4: User Story 2 - Preserve Runtime Behavior During Import Migration (Priority: P1)

**Goal**: Prove the import migration did not change backend runtime contracts or key retrieval-backed flows.

**Independent Test**: Backend build, composition tests, and focused touched-area tests pass.

### Tests for User Story 2

- [X] T014 [US2] Run cd backend && npm run build
- [X] T015 [US2] Run cd backend && npm run test:composition
- [X] T016 [US2] Run cd backend && npx vitest run tests/unit/retrieval-pipeline-stages.test.ts tests/unit/retrieval-settings-and-chunking.test.ts tests/unit/retrieval-trace.test.ts tests/unit/retrieval-execution-telemetry-service.test.ts tests/unit/hybrid-retrieval-search.test.ts tests/unit/hybrid-retrieval-info.test.ts tests/unit/candidate-retrieval-branches.test.ts tests/unit/query-rewrite-subqueries.test.ts tests/unit/llm-provider-registry.test.ts tests/unit/structured-chunking.test.ts
- [X] T017 [US2] Run cd backend && npx vitest run tests/unit/chat-service-streaming.test.ts tests/unit/chat-history-service.test.ts tests/unit/chat-bootstrap-service.test.ts tests/unit/chat-presenter.test.ts tests/unit/chat-retrieval.domain.test.ts tests/unit/conversation-intent-snapshot.test.ts tests/unit/chat-execution-policy.test.ts
- [X] T018 [US2] Run cd backend && npx vitest run tests/unit/document-ingestion.test.ts tests/unit/document-processing-worker-runtime.test.ts tests/unit/document-import-service.test.ts tests/unit/document-deletion.test.ts tests/unit/document-search-history-service.test.ts tests/unit/document-subject-search-text.test.ts tests/unit/ingestion-settings.test.ts

### Implementation for User Story 2

- [X] T019 [US2] Fix any compile or test failures caused by the import migration without changing runtime behavior

**Checkpoint**: Existing behavior remains intact.

---

## Phase 5: User Story 3 - Catch Boundary Regressions In CI (Priority: P2)

**Goal**: CI blocks future direct production imports from retrieval internals.

**Independent Test**: `.github/workflows/ci.yml` runs `npm run lint:boundaries` after backend dependency installation.

### Tests for User Story 3

- [X] T020 [US3] Re-run cd backend && npm run lint:boundaries after CI workflow changes

### Implementation for User Story 3

- [X] T021 [US3] Add the backend boundary lint step to .github/workflows/ci.yml after backend dependency installation

**Checkpoint**: Boundary enforcement runs locally and in CI.

---

## Phase 6: User Story 4 - Document The Public-Surface Pattern (Priority: P3)

**Goal**: Maintainers can repeat the public-surface pattern after the retrieval pilot.

**Independent Test**: Documentation states production imports go through `public.ts`, retrieval is the pilot, tests are excluded in the first pass, and documents/chat/settings are future candidates.

### Tests for User Story 4

- [X] T022 [US4] Read docs/document-writer-prompt.md before editing architecture documentation

### Implementation for User Story 4

- [X] T023 [US4] Update docs/architecture-extension-points.md with the module public-surface pattern and retrieval pilot

**Checkpoint**: Maintainer-facing documentation matches the enforced boundary.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Keep Speckit artifacts, validation evidence, and review readiness aligned.

- [X] T024 Update specs/058-retrieval-module-boundaries/quickstart.md if validation commands differ from implementation
- [X] T025 Confirm specs/058-retrieval-module-boundaries/plan.md records no API, SDK, MCP, database, queue, prompt, or frontend contract changes
- [X] T026 Run git diff origin/main... to review final scope against the approved spec
- [X] T027 Run final validation: cd backend && npm run lint:boundaries && npm run build && npm run test:composition

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Start immediately.
- **Foundational (Phase 2)**: Depends on setup so the public surface can be added under active enforcement.
- **US1 (Phase 3)**: Depends on the public surface.
- **US2 (Phase 4)**: Depends on US1 import migration.
- **US3 (Phase 5)**: Depends on a passing local boundary rule.
- **US4 (Phase 6)**: Can run after the public-surface pattern is confirmed.
- **Polish (Phase 7)**: Depends on all selected stories.

### Parallel Opportunities

- T008 and T009 touch app files and can be split from T010/T011 if separate engineers own those modules.
- T016, T017, and T018 can run independently after T014 succeeds.
- T021 and T023 touch different files and can run in parallel after T013 passes.

## Implementation Strategy

1. Add enforcement first and observe the expected red failure.
2. Add `public.ts`, then migrate production imports module-by-module.
3. Run boundary lint after the migration, then run compile and focused tests.
4. Wire CI only after local enforcement passes.
5. Document the pattern once the implementation proves the boundary shape.
