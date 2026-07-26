# Tasks: Generic Embedding Spaces and Vector Ports

**Input**: Approved [spec.md](./spec.md) and [plan.md](./plan.md)  
**Tests**: Backend tasks follow TDD; test tasks precede production tasks in every slice.

## Phase 1: Setup and Reproducible Gates

- [x] T001 Pin the supported pgvector image/version consistently in `infra/docker-compose.yml`, `.github/workflows/`, `backend/scripts/`, and schema-generation configuration.
- [ ] T002 [P] Add deterministic `embedding-index-v1` fixture generation, runtime-resource capture, warm-up/run controls, dimensions, corpus sizes, selectivity and candidate-depth matrix in `scripts/performance/embedding-index-fixture.ts` and `tests/performance/embedding-index-benchmark.test.ts`.
- [ ] T003 [P] Add deterministic `vector-projection-v1` fixed DB/backend fixture, worker concurrency, event-rate, warm-up and run-duration harness in `scripts/performance/vector-projection-fixture.ts` and `tests/performance/vector-projection-benchmark.test.ts`.
- [ ] T004 Record committed benchmark commands, exact-cutoff decision fields, recall calculation and environment manifest in `specs/872-embedding-model-profiles/quickstart.md`.

---

## Phase 2: Foundational Domain, Persistence, and Ports

- [x] T005 [P] Write failing immutable identity, bounds, compatibility and credential-exclusion tests in `backend/tests/unit/embeddingProfiles/embeddingSpace.test.ts`.
- [x] T006 [P] Write failing lifecycle, generation-fence, quarantine, cancellation, promotion and cleanup predicate tests in `backend/tests/unit/embeddingProfiles/profileLifecycle.test.ts`.
- [x] T007 [P] Write failing backend-neutral score, filter, capability and mutation-version semantics tests in `backend/tests/unit/retrieval/vectorContracts.test.ts`.
- [x] T008 Implement immutable space/profile value objects and lifecycle rules in `backend/src/modules/embeddingProfiles/domain/embeddingSpace.ts` and `backend/src/modules/embeddingProfiles/domain/profileLifecycle.ts`.
- [x] T009 Implement mandatory capability, writer, candidate-search and administration ports in `backend/src/modules/retrieval/domain/vectorAdapter.ts`, replacing optional-method growth in `backend/src/modules/retrieval/domain/vectorIndex.ts`.
- [x] T010 [P] Write failing migration/repository tests for immutable profiles, transitions, canonical vectors, fenced jobs, projection work and checkpoints in `backend/tests/integration/embedding-profile-repositories.integration.test.ts`.
- [x] T011 Add bounded additive migrations after the current migration in `backend/src/db/migrations/` for `embedding_spaces`, internal workspace profiles/transitions, `chunk_embeddings`, profile-pinned durable jobs, `vector_index_work`, and `vector_index_checkpoints`.
- [x] T012 Implement narrow repositories and compare-and-swap transactions in `backend/src/db/repositories/embeddingProfileRepository.ts`, `backend/src/db/repositories/chunkEmbeddingRepository.ts`, and `backend/src/db/repositories/vectorIndexWorkRepository.ts`.
- [x] T013 Regenerate `backend/src/db/schema.sql` and `backend/src/shared/infra/kysely/schema.ts` using the repository generation commands.
- [x] T014 Export the focused module boundary from `backend/src/modules/embeddingProfiles/public.ts` and document ownership in `backend/src/modules/embeddingProfiles/README.md`.

**Checkpoint**: Domain and persistence support multiple immutable dimensions without changing public settings.

---

## Phase 3: User Story 1 — Current Four Models at Supported Dimensions (P1)

**Goal**: Preserve the four-model product surface while making validation, generation,
storage and retrieval dimension-independent internally.

- [x] T015 [P] [US1] Write failing catalog tests asserting exactly the current four identifiers and their typed capabilities in `backend/tests/unit/embeddingProfiles/supportedEmbeddingModels.test.ts`.
- [x] T016 [P] [US1] Write failing provider-neutral probe/embed validation tests for count, mixed dimensions, non-finite, zero, normalization, timeout, batch and size limits in `backend/tests/unit/embeddingProfiles/embeddingVectorValidator.test.ts`.
- [x] T017 [P] [US1] Write failing explicit binding-resolution tests proving provider routing does not use model-name prefixes and credential rotation preserves space identity in `backend/tests/unit/embeddingProfiles/embeddingProviderResolver.test.ts`.
- [x] T018 [US1] Implement the internal four-model descriptor catalog and provider-neutral contracts in `backend/src/modules/embeddingProfiles/contracts/embeddingProvider.ts` and `backend/src/shared/infra/llm/supportedEmbeddingModels.ts`.
- [x] T019 [US1] Implement fixed-input probing, bounded batch splitting and vector validation in `backend/src/modules/embeddingProfiles/services/embeddingVectorValidator.ts`.
- [x] T020 [P] [US1] Adapt explicit model/dimension/purpose handling for OpenAI in `backend/src/shared/infra/llm/openaiProvider.ts` after adding failing adapter tests in `backend/tests/unit/openaiEmbeddingAdapter.test.ts`.
- [x] T021 [P] [US1] Adapt Gemini task mapping, observed dimensions and normalization in `backend/src/shared/infra/llm/geminiProvider.ts` after adding failing adapter tests in `backend/tests/unit/geminiEmbeddingAdapter.test.ts`.
- [x] T022 [US1] Implement workspace credential and opaque endpoint-scope resolution in `backend/src/shared/infra/llm/providerRegistry.ts` without prefix inference or secret-bearing fingerprints.
- [x] T023 [US1] Refactor generation to consume the provider-neutral contract in `backend/src/modules/embeddingProfiles/services/embeddingGenerationService.ts` and `backend/src/shared/infra/llm/embeddingInferencePipeline.ts`.
- [x] T024 [US1] Write failing canonical persistence tests across 768, 1536, 3072 and high-dimensional fixtures in `backend/tests/integration/chunk-embedding-repository.integration.test.ts`.
- [x] T025 [US1] Persist validated full-precision vectors and immutable space identity through `backend/src/db/repositories/chunkEmbeddingRepository.ts` and `backend/src/modules/documents/infra/chunkRepository.ts`.
- [x] T026 [P] [US1] Extend `backend/tests/contract/settings.contract.test.ts` to assert unchanged request/response shapes, permissions, active/pending fields, four-model enum, and legacy equal-value no-op behavior.
- [x] T027 [P] [US1] Extend `frontend/tests/e2e/provider-settings.spec.ts` to assert exactly four choices and absence of custom model, dimension, profile and vector-backend controls.
- [x] T028 [US1] Preserve the existing settings contract in `backend/src/modules/settings/domain/ingestionSettings.ts`, `backend/src/modules/settings/services/ingestionSettingsService.ts`, `backend/src/app/http/routes/settingsRoutes.ts`, and `backend/src/app/http/presenters/settingsPresenter.ts`.
- [x] T029 [US1] Preserve existing provider UI behavior in `frontend/components/dashboard/settings/providers-panel.tsx`, `frontend/components/dashboard/settings/model-picker.tsx`, and `frontend/components/dashboard/settings/ingestion-settings-panel.tsx`.

**Checkpoint**: All four current models validate and round-trip at their supported
dimensions with unchanged public settings/API/UI.

---

## Phase 4: User Story 2 — Zero-Downtime Internal Transition (P1)

**Goal**: Model changes use active/pending internal spaces and automatic fenced
promotion without exposing new public lifecycle resources.

- [x] T030 [P] [US2] Write failing transition coordinator tests for single-pending enforcement, validation failure, automatic promotion, cancellation, generation races and seven-day safe cleanup in `backend/tests/unit/embeddingProfiles/embeddingTransitionCoordinator.test.ts`.
- [x] T031 [P] [US2] Write failing durable-job tests for active/pending work, pinned profile/revision/generation, retry, restart, stale completion and no document-state churn in `backend/tests/unit/documents/embeddingProfileJobService.test.ts`.
- [ ] T032 [P] [US2] Write failing PostgreSQL concurrency tests for publication/deletion/promotion/cancel/cleanup under one generation fence in `backend/tests/integration/embedding-profile-transition.integration.test.ts`.
- [x] T033 [US2] Implement transition start, coverage reconciliation, CAS promotion, cancellation, quarantine and terminal failure in `backend/src/modules/embeddingProfiles/services/embeddingTransitionCoordinator.ts`.
- [x] T034 [US2] Implement separate resumable embedding-only processing in `backend/src/modules/documents/services/embeddingProfileJobService.ts` without revision, document status, chunk, or enrichment mutation.
- [x] T035 [US2] Atomically create active/pending embedding jobs during canonical publication in `backend/src/modules/documents/services/documentProcessingService.ts` and `backend/src/db/repositories/documentJobRepository.ts`.
- [x] T036 [US2] Reconcile upload, update, disable, expiry, re-enable and deletion changes into active/pending coverage in `backend/src/modules/embeddingProfiles/services/embeddingCoverageReconciler.ts`.
- [ ] T037 [US2] Add system-owned grace-period cleanup with live-reference refusal in `backend/src/modules/embeddingProfiles/services/embeddingProfileCleanupService.ts`.
- [ ] T038 [P] [US2] Add queue compatibility, lease, duplicate delivery and restart regression tests in `backend/tests/integration/document-job-queue.integration.test.ts` and `backend/tests/contract/document.contract.test.ts`.
- [x] T039 [US2] Keep identifier-only messages unchanged while routing the new durable job kind in `backend/src/modules/documents/services/documentJobMessage.ts`, `backend/src/modules/documents/services/documentJobDispatcher.ts`, and `backend/src/modules/documents/services/documentProcessingWorker.ts`.
- [x] T040 [P] [US2] Extend `frontend/tests/e2e/provider-settings.spec.ts` for existing confirmation, active/pending display, cancellation and safe-failure behavior only.
- [ ] T041 [US2] Map internal transition state into the existing settings response and UI in `backend/src/modules/settings/services/ingestionSettingsService.ts` and `frontend/components/dashboard/settings/providers-panel.tsx` without exposing IDs or new controls.

**Checkpoint**: Retrieval remains on the complete active space until one automatic,
fenced promotion; cancellation/failure preserve the active model.

---

## Phase 5: User Story 3 — Predictable Dimension-Safe Retrieval (P2)

**Goal**: Search only the active compatible space with explicit readiness and
benchmark-qualified acceleration/fallback.

- [x] T042 [P] [US3] Write failing pgvector integration cases for active-space isolation, incompatible dimensions, cosine score normalization, inclusive threshold, tie-breaking and canonical hydration in `backend/tests/integration/vector-adapter-pg.integration.test.ts`.
- [x] T043 [P] [US3] Write failing exact/accelerated readiness and activation-gate cases across benchmark dimensions and corpus thresholds in `backend/tests/integration/vector-index-readiness.integration.test.ts`.
- [x] T044 [P] [US3] Write failing lexical-continuity and semantic degraded/unavailable behavior tests in `backend/tests/unit/retrieval/retrievalDegradation.test.ts`.
- [x] T045 [US3] Implement pgvector capabilities, exact candidate search and canonical full-precision scoring in `backend/src/modules/retrieval/infra/pgVectorAdapter.ts`.
- [ ] T046 [US3] Implement benchmark-qualified HNSW, half-precision or binary candidate routes with oversampling and canonical rerank in `backend/src/modules/retrieval/infra/pgVectorIndexRoutes.ts`.
- [ ] T047 [US3] Route query embedding/search exclusively through the active space in `backend/src/modules/retrieval/services/retrievalSearchService.ts` and hydrate/enforce canonical eligibility in `backend/src/modules/retrieval/infra/chunkCandidateHydrator.ts`.
- [x] T048 [US3] Implement readiness, exact-cutoff and activation gating in `backend/src/modules/embeddingProfiles/services/embeddingProfileReadinessService.ts`.
- [ ] T049 [US3] Run and commit reproducible benchmark result manifests under `tests/performance/results/embedding-index-v1/`, enabling only routes meeting the plan's latency/recall gates.
- [ ] T050 [US3] Expose degraded/unavailable semantic state through the existing retrieval/settings diagnostics surfaces in `backend/src/modules/retrieval/services/retrievalDiagnosticsStage.ts` and `backend/src/app/http/presenters/settingsPresenter.ts` without new selectable resources.

**Checkpoint**: Semantic search is dimension-safe and route readiness is explicit;
unsafe activation is blocked.

---

## Phase 6: User Story 4 — Stable Vector Backend Contract (P2)

**Goal**: Prove a future backend can implement the common contract without adding a
production external adapter or changing public APIs.

- [x] T051 [P] [US4] Build failing backend-neutral conformance cases for capabilities, prepare/reset, versioned upsert/supersede/filter updates/delete, duplicates, out-of-order delivery, stale candidates, health and complete `topK` in `backend/tests/contract/vector-adapter-conformance.ts`.
- [x] T052 [P] [US4] Implement a test-only in-memory external-style adapter in `backend/tests/support/inMemoryVectorAdapter.ts` and run the conformance suite without PostgreSQL.
- [x] T053 [P] [US4] Run the same logical conformance cases against pgvector in `backend/tests/integration/vector-adapter-conformance.integration.test.ts`.
- [ ] T054 [P] [US4] Write failing atomic outbox, monotonic version, tombstone, checkpoint, lag, retry and scoped rebuild tests in `backend/tests/integration/vector-index-reconciliation.integration.test.ts`.
- [x] T055 [US4] Atomically append versioned projection work from canonical embedding and projected-filter mutations in `backend/src/db/repositories/vectorIndexWorkRepository.ts`.
- [x] T056 [US4] Implement application-owned dispatch, acknowledgment, lag and retry coordination in `backend/src/modules/retrieval/services/vectorIndexReconciler.ts`.
- [ ] T057 [US4] Implement document/workspace/space/deployment rebuild streaming from canonical PostgreSQL through neutral ports in `backend/src/modules/retrieval/services/vectorIndexRebuildService.ts`.
- [x] T058 [US4] Assemble the default pgvector adapter and background lifecycle in `backend/src/app/composition/retrievalComposition.ts` and `backend/src/app/server/dependencyBuilders.ts`.
- [ ] T059 [US4] Run and commit `vector-projection-v1` result manifests under `tests/performance/results/vector-projection-v1/`, including throughput, acknowledgment lag, retry and recovery evidence.

**Checkpoint**: Both adapters pass the same portable behavior; only pgvector is
available in production composition.

---

## Phase 7: Compatibility Rollout, Observability, and Documentation

- [ ] T060 [P] Write failing legacy-profile materialization and mixed/ambiguous workspace tests in `backend/tests/integration/embedding-profile-legacy-rollout.integration.test.ts`.
- [ ] T061 Implement resumable legacy profile materialization, shadow population/validation and workspace-scoped read cutover in `backend/src/modules/embeddingProfiles/services/legacyEmbeddingProfileReconciler.ts`.
- [ ] T062 Add bounded audits, logs, traces and metrics for transitions, validation, readiness, lag, retries, fallback, cleanup and rebuild in `backend/src/modules/embeddingProfiles/services/embeddingProfileTelemetry.ts` and `backend/src/modules/retrieval/services/vectorIndexTelemetry.ts`.
- [ ] T063 [P] Add observability tests proving bounded metric labels and absence of content, vectors, endpoints, credentials and internal IDs from public/audit payloads in `backend/tests/unit/embeddingProfiles/embeddingProfileTelemetry.test.ts`.
- [x] T064 Verify generated OpenAPI and TypeScript SDK diffs preserve existing settings operations/types with `backend/tests/contract/openapi.contract.test.ts` and `backend/tests/contract/sdk-openapi.contract.test.ts`; do not add profile, dimension, rollback, rebuild or backend-selection operations.
- [ ] T065 Update operator settings copy and transition/degradation documentation in `frontend/components/dashboard/settings/settings-docs.ts`, `docs/settings.md`, and matching `docs-portal/content/` pages after reading `docs/document-writer-prompt.md`.
- [ ] T066 Update vector/index, worker/queue, rollout and module-boundary docs in `docs/architecture/vector-search-indexing.md`, `docs/architecture/code-map.md`, `backend/src/modules/retrieval/README.md`, and `backend/src/modules/documents/README.md`.
- [ ] T067 Run focused backend unit/integration/contract suites, frontend unit/Playwright regression, benchmark gates, and `pnpm run ci:local -- origin/main`; record results in the implementation PR.

## Phase 8: Embedding Generation Ownership Correction

- [x] T068 [P] Write failing architecture and contract tests proving Retrieval exports only a purpose-specific query-embedding port and cannot import provider/model/dimension contracts in `backend/tests/unit/embeddingProfiles/embeddingConsumerPorts.test.ts` and the boundary-check fixtures.
- [x] T069 Move the validated shared embedding generation service and gateway contracts from `backend/src/modules/retrieval/services/embeddingService.ts` into `backend/src/modules/embeddingProfiles/services/embeddingGenerationService.ts` and export them only from `backend/src/modules/embeddingProfiles/public.ts`.
- [x] T070 Refactor Retrieval to consume a `QueryEmbeddingPort` that accepts workspace/text context and returns an opaque embedding-space reference plus vector in `backend/src/modules/retrieval/services/candidateRetrievalStage.ts`, `backend/src/modules/retrieval/services/agenticTools/semanticSearchTool.ts`, and related pipeline wiring.
- [x] T071 [P] Refactor Documents to consume a purpose-specific `DocumentEmbeddingPort` without provider/model/dimension options in `backend/src/modules/documents/services/documentProcessingService.ts` and related tests.
- [x] T072 [P] Refactor semantic chunking to consume a purpose-specific `ClusteringEmbeddingPort` without provider/model/dimension/purpose options in `backend/src/modules/retrieval/domain/chunking/chunkingProvider.ts`, `backend/src/modules/retrieval/infra/chonkieChunkingProvider.ts`, and related tests.
- [x] T073 Update application composition and provider-registry construction so it alone binds active profile, descriptor, provider, dimensions, purpose, and usage context to the three consumer ports in `backend/src/app/composition/` and `backend/src/app/server/dependencyBuilders.ts`.
- [x] T074 Remove general embedding generation exports and implementation files from Retrieval, update its README boundary, and run dependency-boundary, focused retrieval/document/chunking, TypeScript, and backend build validation.

## Dependencies and Parallel Work

- Phase 2 blocks all user stories.
- Phase 8 is an approved architecture correction and blocks all remaining
  implementation after the completed foundation.
- US1 blocks transition generation and query embedding.
- US2 and the outbox persistence portion of US4 must precede automatic activation.
- US3 benchmark evidence blocks enabling accelerated routes and unsafe-size activation.
- After Phase 2, provider adapter tests (T020–T021), public-contract regressions
  (T026–T027), transition tests (T030–T032), and conformance harness work
  (T051–T054) can proceed in parallel because their primary files are disjoint.
- Shared files `ingestionSettingsService.ts`, `providers-panel.tsx`,
  `dependencyBuilders.ts`, generated schema/OpenAPI artifacts, and documentation are
  integration points and should have one owner at a time.

## Scope Guard

Implementation must not add public custom-model or requested-dimension input, profile
resources, vector-backend controls, public rollback/rebuild controls, new SDK/MCP
selection operations, or a Pinecone/other production adapter. Playwright covers only
the existing four-model settings journey and its compatible active/pending/cancel
behavior.
