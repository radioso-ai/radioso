# Tasks: Radioso TypeScript SDK

**Input**: Design documents from `/specs/022-typescript-sdk-repo/`  
**Prerequisites**: [plan.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/plan.md), [spec.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/spec.md), [research.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/research.md), [data-model.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/data-model.md), [quickstart.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/quickstart.md), [sdk-surface-contract.md](/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/contracts/sdk-surface-contract.md)

**Tests**: Backend contract tests are REQUIRED before backend contract changes. SDK unit and integration tests are required before package implementation tasks.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the package skeleton and shared sync entrypoints.

- [x] T001 [P] Create the SDK package manifest and TypeScript config in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/package.json` and `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tsconfig.json`
- [x] T002 [P] Create the SDK source and test directory skeleton in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/` and `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/`
- [x] T003 [P] Add the contract sync script scaffold in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/scripts/sync-openapi.mjs`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Normalize token-auth contract metadata and establish package sync before any user story implementation.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 [P] Add failing backend contract coverage for token-auth security metadata in `/Users/dm/conductor/workspaces/radioso/colombo/backend/tests/contract/openapi.contract.test.ts`
- [x] T005 [P] Add failing SDK contract sync coverage in `/Users/dm/conductor/workspaces/radioso/colombo/backend/tests/contract/sdk-openapi.contract.test.ts`
- [x] T006 Correct token-auth security scheme modeling in `/Users/dm/conductor/workspaces/radioso/colombo/backend/src/app/http/openapi/document.ts`
- [x] T007 Regenerate backend OpenAPI artifacts in `/Users/dm/conductor/workspaces/radioso/colombo/backend/openapi.json` and `/Users/dm/conductor/workspaces/radioso/colombo/backend/openapi.yaml`
- [x] T008 Implement the SDK contract snapshot sync flow in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/scripts/sync-openapi.mjs`
- [x] T009 Materialize synced SDK contract snapshots in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/openapi/radioso.json` and `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/openapi/radioso.yaml`

**Checkpoint**: The backend contract correctly describes token auth, and the SDK package can refresh from backend artifacts.

---

## Phase 3: User Story 1 - Integrate Radioso with a Token (Priority: P1) 🎯 MVP

**Goal**: External developers can initialize the SDK with a base URL and API token and call the supported token-first operations without raw HTTP wrappers.

**Independent Test**: Configure the SDK with a token and successfully execute at least one in-scope workspace/document/settings/chat request using only the public SDK surface.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T010 [P] [US1] Add failing SDK configuration and request tests in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/unit/sdk-config.test.ts`
- [x] T011 [P] [US1] Add failing SDK error normalization tests in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/unit/sdk-errors.test.ts`
- [x] T012 [P] [US1] Add failing token-based client integration coverage in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/integration/sdk-client.integration.test.ts`

### Implementation for User Story 1

- [x] T013 [P] [US1] Generate SDK request and response types into `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/generated/types.ts`
- [x] T014 [P] [US1] Generate or materialize the core operation client in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/generated/client.ts`
- [x] T015 [P] [US1] Implement SDK configuration ownership in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/core/config.ts`
- [x] T016 [P] [US1] Implement normalized SDK error handling in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/core/errors.ts`
- [x] T017 [US1] Implement the runtime HTTP wrapper in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/core/http.ts`
- [x] T018 [US1] Compose the public token-first SDK surface in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/index.ts`

**Checkpoint**: The v1 token-first request/response SDK surface works independently.

---

## Phase 4: User Story 2 - Consume Streaming Chat Without Parsing SSE (Priority: P2)

**Goal**: External developers can consume typed streaming chat events without writing their own SSE parser.

**Independent Test**: Start a streaming chat request through the SDK and consume ordered typed events through completion or explicit failure.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T019 [P] [US2] Add failing stream parsing unit coverage in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/unit/chat-stream.test.ts`
- [x] T020 [P] [US2] Add failing streaming chat integration coverage in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/integration/sdk-chat-stream.integration.test.ts`

### Implementation for User Story 2

- [x] T021 [P] [US2] Implement typed streaming event parsing in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/streaming/chatStream.ts`
- [x] T022 [US2] Expose streaming chat through the public SDK surface in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/src/index.ts`
- [x] T023 [US2] Ensure generated and handwritten chat surfaces stay aligned during contract sync in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/scripts/sync-openapi.mjs`

**Checkpoint**: Streaming chat is consumable through the SDK without raw SSE parsing.

---

## Phase 5: User Story 3 - Keep the SDK Aligned with the Backend Contract (Priority: P3)

**Goal**: Maintainers can refresh the SDK after backend contract changes and detect drift before release.

**Independent Test**: Change an in-scope backend contract shape, rerun generation and sync, and verify the SDK artifacts and docs refresh cleanly.

### Tests for User Story 3 (REQUIRED for backend)

- [x] T024 [P] [US3] Add failing package sync and generated-artifact drift coverage in `/Users/dm/conductor/workspaces/radioso/colombo/backend/tests/contract/sdk-openapi.contract.test.ts`
- [x] T025 [P] [US3] Add failing quickstart validation coverage or scripted checks in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/integration/sdk-client.integration.test.ts`

### Implementation for User Story 3

- [x] T026 [P] [US3] Document the v1 SDK surface and quickstart in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/README.md`
- [x] T027 [P] [US3] Document the SDK refresh workflow in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/README.md`
- [x] T028 [US3] Finalize package scripts for build, test, and sync in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/package.json`

**Checkpoint**: Maintainers can refresh and validate the SDK against backend contract changes.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, cleanup, and documentation parity across all stories.

- [x] T029 [P] Run focused backend contract validation in `/Users/dm/conductor/workspaces/radioso/colombo/backend/tests/contract/`
- [x] T030 [P] Run SDK package unit and integration validation in `/Users/dm/conductor/workspaces/radioso/colombo/typescript-sdk/tests/`
- [ ] T031 Run the quickstart scenarios from `/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/quickstart.md`
- [x] T032 Update feature task status and linked docs in `/Users/dm/conductor/workspaces/radioso/colombo/specs/022-typescript-sdk-repo/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on Foundational completion and benefits from US1 runtime HTTP/config seams.
- **User Story 3 (Phase 5)**: Depends on Foundational completion and should follow the package surface established in US1 and US2.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; no dependency on streaming behavior.
- **User Story 2 (P2)**: Depends on US1 transport/config scaffolding.
- **User Story 3 (P3)**: Depends on the contract sync flow from Foundational and benefits from the final public SDK surface from US1 and US2.

### Within Each User Story

- Backend contract tests MUST be written and FAIL before backend contract changes.
- SDK unit and integration tests MUST be written and FAIL before implementation.
- Contract normalization and sync flow land before generated client work.
- Generated transport lands before public SDK composition.
- Streaming adapter lands before public streaming exposure.
- Documentation and refresh workflow complete before final validation.

### Parallel Opportunities

- Phase 1 package-manifest, directory, and script-scaffold tasks marked `[P]` can run in parallel.
- Phase 2 contract tests can run in parallel before backend contract and sync implementation.
- In US1, generated types, config, and error work can proceed in parallel before final public-surface composition.
- In US2, stream unit tests and integration tests can be authored in parallel.
- In US3, README surface docs and refresh workflow docs can proceed in parallel.

---

## Parallel Example: User Story 1

```bash
# Launch failing SDK tests together:
Task: "Add failing SDK configuration and request tests in typescript-sdk/tests/unit/sdk-config.test.ts"
Task: "Add failing SDK error normalization tests in typescript-sdk/tests/unit/sdk-errors.test.ts"
Task: "Add failing token-based client integration coverage in typescript-sdk/tests/integration/sdk-client.integration.test.ts"

# Launch focused SDK modules together:
Task: "Generate SDK request and response types into typescript-sdk/src/generated/types.ts"
Task: "Implement SDK configuration ownership in typescript-sdk/src/core/config.ts"
Task: "Implement normalized SDK error handling in typescript-sdk/src/core/errors.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Verify token-based SDK requests independently.
5. Demo the token-first package surface before adding streaming ergonomics.

### Incremental Delivery

1. Complete Setup + Foundational to normalize the contract and package sync flow.
2. Add User Story 1 and validate token-first request/response operations.
3. Add User Story 2 and validate streaming chat ergonomics.
4. Add User Story 3 and validate maintainer refresh and drift detection.
5. Finish with Polish and quickstart verification.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together.
2. Once Foundational is done:
   - Developer A: User Story 1 generated client and runtime surface
   - Developer B: User Story 2 streaming adapter
   - Developer C: User Story 3 docs and refresh validation
3. Rejoin for final validation and packaging polish.

---

## Notes

- `[P]` tasks touch different files with no unresolved dependencies.
- `[US1]`, `[US2]`, and `[US3]` map directly to approved user stories.
- `backend/src/app/http/openapi/document.ts` remains the source of truth for HTTP contract changes; `backend/openapi.yaml` and `backend/openapi.json` are generated outputs.
- Avoid pushing SDK runtime logic into backend code or collapsing all package behavior into `typescript-sdk/src/index.ts`.
