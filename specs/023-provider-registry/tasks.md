# Tasks: Provider-Agnostic LLM Registry

**Input**: Design documents from `/specs/023-provider-registry/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Backend tests are REQUIRED. New or updated tests must fail before implementation changes land.

**Organization**: Tasks are grouped by user story so each story can be implemented and validated independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the approved feature artifacts and current provider-coupled files before implementation.

- [x] T001 Verify feature artifacts in `specs/023-provider-registry/` and current provider-coupled files in `backend/src/app/config/env.ts`, `backend/src/app/server/dependencies.ts`, and `backend/src/shared/infra/`
- [x] T002 Review existing gateway seams and backend test factories in `backend/src/modules/chat/services/`, `backend/src/modules/retrieval/services/`, and `backend/tests/support/testApp.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish provider-neutral config and capability seams before caller rewiring.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Add failing provider-registry and env validation tests in `backend/tests/unit/llm-provider-registry.test.ts`
- [x] T004 [P] Define provider config, capability, and metadata types in `backend/src/shared/infra/llm/providerTypes.ts` and `backend/src/shared/infra/llm/providerConfig.ts`
- [x] T005 [P] Extract provider-neutral registry construction in `backend/src/shared/infra/llm/providerRegistry.ts`
- [x] T006 [P] Update environment parsing defaults and provider-neutral settings in `backend/src/app/config/env.ts`
- [x] T007 Update `backend/.env.example` with provider-neutral configuration examples and required secrets

**Checkpoint**: Provider-neutral configuration and registry seams exist, with failing tests protecting unsupported mappings and defaults.

---

## Phase 3: User Story 1 - Switch Providers by Configuration (Priority: P1) 🎯 MVP

**Goal**: Allow chat and retrieval-related model capabilities to resolve from configuration while preserving default-provider behavior.

**Independent Test**: Run provider-registry tests and chat/retrieval domain tests to confirm default behavior still works and at least one alternate provider mapping resolves cleanly.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T008 [P] [US1] Add dependency-wiring and config-resolution tests in `backend/tests/unit/llm-provider-registry.test.ts`
- [x] T009 [P] [US1] Update chat/retrieval gateway tests in `backend/tests/unit/chat-retrieval.domain.test.ts`

### Implementation for User Story 1

- [x] T010 [P] [US1] Implement OpenAI and OpenAI-compatible capability adapters in `backend/src/shared/infra/llm/openaiProvider.ts`
- [x] T011 [P] [US1] Implement Gemini capability adapters in `backend/src/shared/infra/llm/geminiProvider.ts`
- [x] T012 [P] [US1] Implement Claude text-generation adapters in `backend/src/shared/infra/llm/claudeProvider.ts`
- [x] T013 [US1] Replace OpenAI-only dependency construction in `backend/src/app/server/dependencies.ts` with provider-registry wiring
- [x] T014 [US1] Keep `backend/src/modules/chat/services/chatService.ts`, `backend/src/modules/retrieval/services/embeddingService.ts`, `backend/src/modules/retrieval/services/queryRewriteService.ts`, and `backend/src/modules/retrieval/services/rerankService.ts` consuming provider-neutral gateways only

**Checkpoint**: The backend can resolve default and alternate provider paths through configuration without changing caller APIs.

---

## Phase 4: User Story 2 - Add New Providers Behind Stable Seams (Priority: P2)

**Goal**: Make provider additions or maintenance local to shared infrastructure adapters and configuration.

**Independent Test**: Run focused provider-registry tests proving incompatible capability mappings fail early and orchestration files remain vendor-neutral.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T015 [P] [US2] Add unsupported-capability and metadata assertions in `backend/tests/unit/llm-provider-registry.test.ts`
- [x] T016 [P] [US2] Update provider-neutral test environment defaults in `backend/tests/support/testApp.ts`

### Implementation for User Story 2

- [x] T017 [P] [US2] Introduce provider metadata and capability validation helpers in `backend/src/shared/infra/llm/providerRegistry.ts` and `backend/src/shared/infra/llm/providerConfig.ts`
- [x] T018 [US2] Update test dependency factories in `backend/tests/support/testApp.ts` to match the new provider-neutral env shape
- [x] T019 [US2] Remove or narrow OpenAI-specific shared wiring in `backend/src/shared/infra/openaiClient.ts` so it no longer represents the architecture boundary

**Checkpoint**: Provider-specific code is isolated to shared infrastructure and tests prove the registry owns compatibility validation.

---

## Phase 5: User Story 3 - Fail Safely When Provider Configuration Is Invalid or Unavailable (Priority: P3)

**Goal**: Ensure configuration mistakes and unsupported capability mappings fail clearly and safely.

**Independent Test**: Run provider-registry tests covering missing secrets, unsupported mappings, and operator-facing failure messages.

### Tests for User Story 3 (REQUIRED for backend)

- [x] T020 [P] [US3] Add startup/dependency validation assertions in `backend/tests/unit/llm-provider-registry.test.ts`

### Implementation for User Story 3

- [x] T021 [US3] Add explicit configuration and capability error handling in `backend/src/shared/infra/llm/providerRegistry.ts` and `backend/src/app/config/env.ts`
- [x] T022 [US3] Surface non-secret provider metadata through logs or diagnostics in `backend/src/app/server/dependencies.ts` and provider infrastructure helpers

**Checkpoint**: Invalid configurations fail early with clear, non-secret errors.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, artifact sync, and review readiness.

- [x] T023 [P] Run targeted validation from `specs/023-provider-registry/quickstart.md`
- [x] T024 Update completed task markers and note residual risks in `specs/023-provider-registry/tasks.md`
- [x] T025 [P] Re-read `specs/023-provider-registry/spec.md`, `plan.md`, and changed code to verify scope fit before review

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Starts after Foundational and delivers the MVP provider-neutral wiring
- **User Story 2 (Phase 4)**: Depends on provider-registry wiring from User Story 1
- **User Story 3 (Phase 5)**: Depends on the registry and env validation paths existing
- **Polish (Phase 6)**: Depends on all desired stories being complete

### Within Each User Story

- Backend tests must be written and fail before implementation tasks for that story
- Capability/config types and registry code land before dependency rewiring
- Provider adapter modules land before composition changes consume them
- Responsibility-limited orchestration files should only be touched after shared infrastructure seams exist

### Parallel Opportunities

- T004-T007 can progress in parallel where file ownership does not overlap
- Provider adapter implementations T010-T012 can proceed in parallel after the registry contract exists
- Provider-registry tests T015, T016, and T020 can run in parallel where file ownership stays separate

## Implementation Strategy

### MVP First

1. Complete Setup and Foundational phases
2. Deliver User Story 1 to switch provider resolution to configuration while preserving default behavior
3. Validate default and alternate provider resolution before adding additional failure-path hardening

### Incremental Delivery

1. Establish provider-neutral config and registry seams
2. Wire OpenAI/OpenAI-compatible, Gemini, and Claude adapters behind existing gateway interfaces
3. Harden validation and provider metadata
4. Finish artifact sync and review

### Parallel Team Strategy

If multiple engineers are involved after the foundational phase:

- Engineer A: env/config and registry validation
- Engineer B: OpenAI/OpenAI-compatible and Gemini adapters
- Engineer C: Claude adapter, test factory updates, and validation

## Notes

- Validation completed with `npx vitest run tests/unit/llm-provider-registry.test.ts tests/unit/chat-retrieval.domain.test.ts tests/unit/chat-service-streaming.test.ts` and `npx tsc -p tsconfig.json --noEmit` in `backend/`.
- Residual risk: Gemini and Claude adapters are covered by compile-time and registry-level tests in this workspace, but not by live-provider integration tests.
