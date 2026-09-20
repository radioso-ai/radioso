# Tasks: Provider-Neutral Input Token Caching

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/inference-input-token-caching.md`, and `quickstart.md`

**Tests**: Backend TDD is required. Each test task must be made red before its production task.

## Phase 1: Contract foundation

**Purpose**: Create the narrow internal seam shared by both product paths and adapters.

- [x] T001 [P] Add boundary/accounting compatibility coverage in `backend/tests/unit/{input-token-caching,model-inference-pipeline}.test.ts` for exact concatenation, unknown versus reported zero, finite non-negative values, and unchanged durable usage totals.
- [x] T002 [P] Add grounded-answer stable-prefix preservation coverage in `backend/tests/unit/grounded-answer-prompt-contract.test.ts`, keeping dynamic steering and conversation/retrieval content outside the prefix.
- [x] T003 [P] Add agent stable-prefix/tool-catalog coverage in `backend/tests/unit/text-routed-tool-calling-gateway.test.ts`, preserving supplied tool order and dynamic current message separation.
- [x] T004 Define `ReusableInputBoundary`, `ProviderCacheCapability`, and normalized `CacheAccounting` in `backend/src/shared/infra/llm/providerTypes.ts`; preserve existing request and durable usage compatibility.
- [x] T005 Implement pure boundary constructors/validation and capability enums in `backend/src/shared/infra/llm/inputTokenCaching.ts`; default invalid or unsupported metadata to ordinary behavior.
- [x] T006 Update `backend/src/modules/chat/services/{groundedAnswerPromptComposer,retrievalTurnSkill,chatGateways}.ts` and `backend/src/modules/chat/contracts/chatGateway.ts` to derive and forward the boundary alongside compatibility strings.
- [x] T007 Update `backend/src/shared/agent-runtime/textRoutedGateway.ts` to derive the stable instructions/protocol/tool catalog prefix and dynamic prompt from the same ordered parts.
- [x] T008 Update `backend/src/shared/infra/llm/modelInferencePipeline.ts` to preserve boundary through strip/budget/trace paths and ensure input-byte/token estimates use exact complete rendered input.

**Checkpoint**: Both callers produce a neutral boundary with no provider behavior changed.

## Phase 2: User Story 1 — Reuse stable model input (P1)

**Goal**: Supported providers receive the exact safe leading boundary; unsupported requests retain ordinary behavior.

**Independent Test**: Equivalent supported requests render the same eligible prefix and different dynamic content outside it, while unsupported model/API-mode configurations use unchanged requests.

- [x] T009 [P] [US1] Add Claude request-shape/capability/error-preservation coverage in `backend/tests/unit/claude-provider-usage.test.ts`; this pilot has no documented native pre-generation discriminator and therefore no retry.
- [x] T010 [P] [US1] Add Gemini request-shape/capability coverage in `backend/tests/unit/gemini-provider-usage.test.ts` for implicit-compatible stable rendering and unsupported configurations.
- [x] T011 [US1] Implement Claude capability resolution, deterministic content-block rendering, explicit checkpoint placement, and no-retry error preservation in `backend/src/shared/infra/llm/claudeProvider.ts`.
- [x] T012 [US1] Implement Gemini capability resolution and implicit-cache-compatible deterministic request rendering in `backend/src/shared/infra/llm/geminiProvider.ts`, with no explicit cache object or retry.
- [x] T013 [US1] Pass the existing `MetricsRegistry` through `backend/src/app/server/builders/{documentRetrievalGraph,integrations}.ts` and `backend/src/shared/infra/llm/providerRegistry.ts` into `ModelInferencePipelineService`; cover it in `backend/tests/unit/llm-provider-registry.test.ts`.

**Checkpoint**: Claude and Gemini exercise explicit/implicit paths; unsupported configurations have ordinary behavior.

## Phase 3: User Story 2 — Understand cache effect and latency (P1)

**Goal**: Operators can distinguish safe accounting states and available timing without sensitive/high-cardinality telemetry.

**Independent Test**: Provider results with read/write, zero, and omitted accounting generate distinct bounded metrics/diagnostics, and streaming records first-adapter-text only after text is yielded.

- [x] T014 [P] [US2] Add Claude usage normalization coverage in `backend/tests/unit/claude-provider-usage.test.ts` for reads/writes, zero, and absent fields.
- [x] T015 [P] [US2] Add Gemini usage normalization coverage in `backend/tests/unit/gemini-provider-usage.test.ts` for reads, zero, and absent write accounting.
- [x] T016 [P] [US2] Add pipeline timing/trace safety coverage in `backend/tests/unit/model-inference-pipeline.test.ts` and `backend/tests/unit/turn-model-call-trace.test.ts`.
- [x] T017 [P] [US2] Add bounded-label/redaction metric coverage in `backend/tests/unit/cache-telemetry.test.ts`.
- [x] T018 [US2] Implement provider accounting extraction in `backend/src/shared/infra/llm/{claudeProvider,geminiProvider}.ts` using shared normalization from `backend/src/shared/infra/llm/inputTokenCaching.ts`.
- [x] T019 [US2] Implement bounded cache/timing telemetry in `backend/src/shared/infra/llm/cacheTelemetry.ts` through `backend/src/shared/observability/metrics/metricsRegistry.ts`.
- [x] T020 [US2] Wire safe telemetry and defined timing boundaries into `backend/src/shared/infra/llm/modelInferencePipeline.ts`.
- [x] T021 [US2] Update transient model-call tracing in `backend/src/shared/observability/tracing/modelCallTraceContext.ts` and `backend/src/shared/infra/llm/modelInferencePipeline.ts`; durable usage schema remains unchanged.

**Checkpoint**: Cache accounting/timing is observable, bounded, and non-durable.

## Phase 4: User Story 3 — Evaluate before expanding (P2)

**Goal**: Maintainers can collect comparable cold/warm/expiry/change/concurrent evidence without overstating live provider results.

**Independent Test**: A reviewer can follow the guide and see required cohort controls, state distinctions, timing definitions, and 20-observation percentile gate.

- [x] T022 [US3] Write the operator/developer evaluation guide in `docs/input-token-caching.md` following `docs/document-writer-prompt.md`.
- [x] T023 [US3] Update `specs/1262-input-token-caching/quickstart.md` with final deterministic validation evidence and the explicit no-live-evaluation record.

## Phase 5: Coverage, verification, and review

- [x] T024 Add the permanent internal-runtime exclusion and focused assertion in `backend/tests/unit/operatorCopilot/{catalogCoverage,copilot-catalog-coverage.test}.ts`.
- [x] T025 Run the final focused Vitest suite and `cd backend && pnpm run build`.
- [x] T026 Run root lint and `pnpm run lint:dead-code:ci`; all touched findings are resolved and dead-code passes. Root lint remains blocked by four unchanged Enterprise billing findings recorded in `quickstart.md`.
- [x] T027 Run deterministic validation and record actual results in `quickstart.md`; no live provider evaluation was run.
- [x] T028 Complete independent senior-engineer review and address the in-scope retry-safety and FR-018 consistency findings.

## Dependencies and parallel execution

- Foundation T001–T008 blocks provider and telemetry work.
- After T004–T005, T009–T013 (provider mapping) and T014–T017 (telemetry tests) can proceed in parallel, but shared files `providerTypes.ts`, `inputTokenCaching.ts`, and `modelInferencePipeline.ts` require one owner at a time.
- US3 documentation begins after telemetry names and states stabilize at T019–T020.
- T024–T028 follow implementation completion.

### Recommended ownership split

1. **Inference/telemetry owner**: T001, T004–T005, T008, T013, T016–T021. Owns `providerTypes.ts`, `inputTokenCaching.ts`, `cacheTelemetry.ts`, `modelInferencePipeline.ts`, required composition wiring, and transient trace/metrics tests.
2. **Prompt/provider owner**: T002–T003, T006–T007, T009–T012, T014–T015, and provider portions of T018. Owns grounded composer/retrieval call, agent gateway, Claude/Gemini adapters, and their focused tests.
3. **Integrator**: T022–T028 after the two owners land; resolves shared-contract integration, coverage-map exclusion, docs, and whole-change validation/review.

## MVP and incremental delivery

First land the neutral boundary plus Claude/Gemini mapping (Phases 1–2) with exact preservation tests. Then add telemetry (Phase 3), documentation/evaluation (Phase 4), and final gates (Phase 5). No phase adds provider cache lifecycle or public surface.
