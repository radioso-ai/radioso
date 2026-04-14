# Tasks: External Document ID

**Input**: Design documents from `/specs/037-external-document-id/`  
**Prerequisites**: [plan.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/plan.md), [spec.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/spec.md), [research.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/research.md), [data-model.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/data-model.md), [quickstart.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/quickstart.md), [document-external-id-contract.md](/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/contracts/document-external-id-contract.md)

**Tests**: Backend tests are REQUIRED and MUST be written before implementation.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare shared fake repositories and document fixtures for the new field.

- [x] T001 [P] Extend shared document repository fakes for `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/support/fakes.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the schema, persistence types, and contract surfaces that every story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T002 [P] Add failing unit coverage for `externalDocumentId` ingest/update behavior in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/document-ingestion.test.ts`
- [x] T003 [P] Add failing document contract coverage for additive request/response fields in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/document.contract.test.ts`
- [x] T004 [P] Add failing persistence coverage for workspace-scoped uniqueness in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/integration/persistence.integration.test.ts`
- [x] T005 Add the additive schema migration for `external_document_id` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/db/migrations/014_external_document_id.sql`
- [x] T006 Extend document repository record/input types and row mapping for `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/db/repositories/documentRepository.ts`
- [x] T007 Add document route schema support for `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/routes/documentRoutes.ts`
- [x] T008 Add code-first document request/response schema support for `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/openapi/document.ts`

**Checkpoint**: Schema, types, and contract surfaces are ready for story implementation.

---

## Phase 3: User Story 1 - Idempotent External Writes (Priority: P1) 🎯 MVP

**Goal**: Repeated create requests with the same `externalDocumentId` in one workspace update the same document instead of creating duplicates.

**Independent Test**: Send the same create request twice with the same `externalDocumentId` in one workspace and confirm one logical document exists with the later content.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T009 [P] [US1] Add failing contract coverage for POST idempotency with `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/document.contract.test.ts`
- [x] T010 [P] [US1] Add failing integration coverage for cross-workspace reuse in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/integration/document-settings.integration.test.ts`
- [x] T011 [P] [US1] Add failing unit coverage for audit/requeue behavior on idempotent writes in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/document-ingestion.test.ts`

### Implementation for User Story 1

- [x] T012 [P] [US1] Implement repository create-or-upsert behavior by workspace and `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/db/repositories/documentRepository.ts`
- [x] T013 [US1] Wire `externalDocumentId` create semantics through `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/documents/services/documentIngestionService.ts`
- [x] T014 [US1] Keep document operation responses stable while returning the canonical internal ID from `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/app/http/routes/documentRoutes.ts`

**Checkpoint**: External-id create writes are tenant-safe and idempotent on the existing contract.

---

## Phase 4: User Story 2 - Preserve Existing Native Document Flows (Priority: P2)

**Goal**: Clients that omit `externalDocumentId` continue to see today’s create/update/list/read/delete behavior.

**Independent Test**: Repeat existing create and update flows without `externalDocumentId` and confirm they remain unchanged.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T015 [P] [US2] Add regression coverage for repeated create requests without `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/document.contract.test.ts`
- [x] T016 [P] [US2] Add regression coverage for read/list payloads exposing nullable `externalDocumentId` in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/document.contract.test.ts`

### Implementation for User Story 2

- [x] T017 [P] [US2] Expose `externalDocumentId` in document summary/details mapping in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/documents/services/documentIngestionService.ts`
- [x] T018 [US2] Refresh generated OpenAPI artifacts in `/Users/dm/conductor/workspaces/radioso/auckland/backend/openapi.yaml` and `/Users/dm/conductor/workspaces/radioso/auckland/backend/openapi.json`

**Checkpoint**: Existing clients remain backward compatible while document reads surface the additive field.

---

## Phase 5: User Story 3 - Stable Ownership of External Identity (Priority: P3)

**Goal**: `externalDocumentId` can be assigned once but not changed after it is set, and tenant-local conflicts are rejected clearly.

**Independent Test**: Assign an `externalDocumentId`, then attempt to change it or reuse it on another document in the same workspace and confirm conflict responses.

### Tests for User Story 3 (REQUIRED for backend)

- [x] T019 [P] [US3] Add failing contract coverage for immutable identity conflicts in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/contract/document.contract.test.ts`
- [x] T020 [P] [US3] Add failing unit coverage for first-assignment versus reassignment behavior in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/unit/document-ingestion.test.ts`

### Implementation for User Story 3

- [x] T021 [P] [US3] Implement immutable external identity guards in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/modules/documents/services/documentIngestionService.ts`
- [x] T022 [US3] Implement repository support for first assignment and tenant-local conflict handling in `/Users/dm/conductor/workspaces/radioso/auckland/backend/src/db/repositories/documentRepository.ts`

**Checkpoint**: External identity assignment is stable, auditable, and conflict-safe.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, artifact sync, and task completion.

- [x] T023 [P] Run focused backend validation for document contract, unit, and persistence flows in `/Users/dm/conductor/workspaces/radioso/auckland/backend/tests/`
- [x] T024 [P] Run the quickstart validation scenarios from `/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/quickstart.md`
- [x] T025 Update feature artifact status and mark completed items in `/Users/dm/conductor/workspaces/radioso/auckland/specs/037-external-document-id/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational completion.
- **User Story 2 (Phase 4)**: Depends on Foundational completion and can follow once the read/write schemas are in place.
- **User Story 3 (Phase 5)**: Depends on Foundational completion and should follow the repository/service seams introduced in US1.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; provides the MVP behavior.
- **User Story 2 (P2)**: Depends on Foundational and validates backward compatibility after US1.
- **User Story 3 (P3)**: Depends on Foundational and shares service/repository seams with US1.

### Within Each User Story

- Backend tests MUST be written and FAIL before implementation.
- Persistence types and helpers land before orchestration changes depend on them.
- Repository behavior before service orchestration.
- Code-first contract updates before generated OpenAPI refresh.
- Story validation before moving to the next priority.

### Parallel Opportunities

- Setup and Foundational tests marked `[P]` can run in parallel.
- In US1, contract, integration, and unit tests can be authored in parallel before repository/service implementation.
- In US2, read/list regression checks can be authored in parallel before OpenAPI regeneration.
- In US3, contract and unit tests can be authored in parallel before immutable-assignment implementation.

---

## Parallel Example: User Story 1

```bash
# Launch failing external-id tests together:
Task: "Add failing contract coverage for POST idempotency with externalDocumentId in backend/tests/contract/document.contract.test.ts"
Task: "Add failing integration coverage for cross-workspace reuse in backend/tests/integration/document-settings.integration.test.ts"
Task: "Add failing unit coverage for audit/requeue behavior on idempotent writes in backend/tests/unit/document-ingestion.test.ts"

# Then implement the repository and service seams:
Task: "Implement repository create-or-upsert behavior by workspace and externalDocumentId in backend/src/db/repositories/documentRepository.ts"
Task: "Wire externalDocumentId create semantics through backend/src/modules/documents/services/documentIngestionService.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: Verify idempotent create behavior by workspace.

### Incremental Delivery

1. Complete Setup + Foundational to establish the additive schema and contract.
2. Add User Story 1 and validate tenant-safe idempotent creates.
3. Add User Story 2 and validate backward-compatible reads and creates.
4. Add User Story 3 and validate immutable assignment/conflicts.
5. Finish with Polish and quickstart verification.

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together.
2. Once Foundational is done:
   - Developer A: User Story 1 repository/service behavior
   - Developer B: User Story 2 contract/read mapping and OpenAPI sync
   - Developer C: User Story 3 immutable assignment rules
3. Rejoin for validation and artifact completion.

---

## Notes

- `[P]` tasks touch different files with no unresolved dependencies.
- `[US1]`, `[US2]`, and `[US3]` keep traceability back to approved user stories.
- Backend TDD is mandatory for this feature.
- `backend/src/app/http/openapi/document.ts` is the source of truth for HTTP contract changes; `backend/openapi.yaml` and `backend/openapi.json` are generated outputs.
- No new external-ID query endpoints are in scope.
