# Tasks: Code-First OpenAPI Contracts

**Input**: Design documents from `/specs/022-code-first-openapi/`
**Prerequisites**: plan.md, spec.md

**Tests**: Backend contract tests and build validation are REQUIRED for this feature. Contract drift coverage must exist before the generated OpenAPI workflow is considered complete.

**Organization**: Tasks are grouped by user story so the code-first contract source, docs exposure, and Speckit workflow updates remain traceable to the user value they protect.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the current API drift, target files, and workflow scope before changing the contract system.

- [x] T001 Verify the current backend contract drift and identify missing or stale API coverage in `backend/openapi.yaml`, `backend/src/app/http/routes/`, and `backend/tests/contract/`
- [x] T002 Review the target Speckit governance and prompt files in `.specify/memory/constitution.md`, `.specify/templates/plan-template.md`, and `.codex/prompts/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish the code-first OpenAPI seam and generation workflow before exposing docs or updating process guidance.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Add or export reusable route validation schemas from `backend/src/app/http/routes/authRoutes.ts`, `accountRoutes.ts`, `workspaceRoutes.ts`, `settingsRoutes.ts`, `documentRoutes.ts`, `chatRoutes.ts`, and `publicChatRoutes.ts`
- [x] T004 [P] Add OpenAPI generation dependencies and scripts in `backend/package.json` and `backend/package-lock.json`
- [x] T005 [P] Create the code-first contract builder in `backend/src/app/http/openapi/document.ts`
- [x] T006 [P] Create the OpenAPI artifact generation script in `backend/scripts/generateOpenApi.ts`
- [x] T007 Wire generated-artifact production into backend validation flows in `backend/package.json`

**Checkpoint**: The backend has a single code-first OpenAPI source and a repeatable generation path.

---

## Phase 3: User Story 1 - Keep Backend API Docs in Sync (Priority: P1) 🎯 MVP

**Goal**: Replace the stale manual contract flow with a code-first backend contract source and generated artifacts that match current implementation behavior.

**Independent Test**: Run `npm run test:contract` in `backend/` and confirm the generated contract matches the implementation and checked-in OpenAPI files without hand-editing the artifacts.

### Tests for User Story 1 (REQUIRED for backend)

- [x] T008 [P] [US1] Add a generated-spec drift check in `backend/tests/contract/openapi.contract.test.ts`
- [x] T009 [P] [US1] Align contract expectations for current document-processing behavior in `backend/tests/contract/document.contract.test.ts`

### Implementation for User Story 1

- [x] T010 [US1] Define the backend path, schema, auth, and response contract coverage in `backend/src/app/http/openapi/document.ts`
- [x] T011 [US1] Regenerate and replace the checked-in artifacts in `backend/openapi.yaml` and `backend/openapi.json`
- [x] T012 [US1] Ensure backend contract validation regenerates artifacts before running contract tests in `backend/package.json`

**Checkpoint**: The checked-in backend OpenAPI artifacts are generated from code and protected by automated drift checks.

---

## Phase 4: User Story 2 - Review and Consume the Generated Contract Easily (Priority: P2)

**Goal**: Make the generated backend contract easy to inspect through the running app and repository artifacts.

**Independent Test**: Build the backend and confirm the generated contract is exposed through `/openapi.json` and `/docs` outside test mode while backend tests remain stable.

### Tests for User Story 2 (REQUIRED for backend)

- [x] T013 [P] [US2] Validate the full backend contract suite with `npm run test:contract` in `backend/`
- [x] T014 [P] [US2] Validate generation plus TypeScript/package integrity with `npm run build` in `backend/`

### Implementation for User Story 2

- [x] T015 [US2] Expose the generated contract and Swagger UI from `backend/src/app/server/createApp.ts`
- [x] T016 [US2] Keep docs exposure out of test mode in `backend/src/app/server/createApp.ts` so the docs surface does not perturb contract tests
- [x] T017 [US2] Preserve the generated JSON artifact for downstream consumption in `backend/openapi.json`

**Checkpoint**: Developers can inspect the generated backend contract through the repository and running backend without destabilizing tests.

---

## Phase 5: User Story 3 - Keep Future Feature Work on the Same Contract System (Priority: P3)

**Goal**: Update Speckit and repo governance so future backend API changes use the code-first OpenAPI workflow by default.

**Independent Test**: Review the constitution, plan template, and Speckit prompts and confirm they direct future backend API work to `backend/src/app/http/openapi/document.ts` and generated artifacts instead of hand-editing `backend/openapi.yaml`.

### Tests for User Story 3 (REQUIRED for backend/process)

- [x] T018 [P] [US3] Create retroactive Speckit feature artifacts in `specs/022-code-first-openapi/spec.md` and `specs/022-code-first-openapi/plan.md`

### Implementation for User Story 3

- [x] T019 [US3] Add a standing code-first backend API contract rule to `.specify/memory/constitution.md`
- [x] T020 [US3] Update the implementation plan template in `.specify/templates/plan-template.md` to treat backend OpenAPI files as generated outputs
- [x] T021 [P] [US3] Update `.codex/prompts/speckit.plan.md` so planned backend API work maps approved contracts to the code-first OpenAPI source
- [x] T022 [P] [US3] Update `.codex/prompts/speckit.tasks.md` so backend API task lists explicitly include code-first OpenAPI updates and regeneration
- [x] T023 [P] [US3] Update `.codex/prompts/speckit.implement.md` so implementation guidance uses the generated-contract workflow instead of manual spec editing

**Checkpoint**: Repo governance and Speckit prompts now preserve the new backend contract workflow.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finalize the retroactive feature documentation and verification trail.

- [x] T024 [P] Regenerate the final backend OpenAPI artifacts with `npm run generate:openapi` in `backend/`
- [x] T025 [P] Re-run backend validation with `npm run test:contract` and `npm run build` in `backend/`
- [x] T026 Update completed task markers and finalize the retroactive Speckit artifacts in `specs/022-code-first-openapi/tasks.md`

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: Starts immediately
- **Foundational (Phase 2)**: Depends on Setup and blocks all user stories
- **User Story 1 (Phase 3)**: Depends on the code-first contract seam and generation workflow
- **User Story 2 (Phase 4)**: Depends on User Story 1 generated artifacts and validation flow
- **User Story 3 (Phase 5)**: Depends on the final contract workflow being clear enough to encode in governance and prompts
- **Polish (Phase 6)**: Depends on all desired stories being complete

### Within Each User Story

- Contract and drift tests must exist before the code-first workflow is considered complete
- The OpenAPI document builder must exist before generated files are treated as authoritative outputs
- Docs exposure should follow generation and remain outside test-mode startup paths
- Repo governance and Speckit prompt updates should happen after the new backend contract workflow is concrete enough to reference precisely

### Parallel Opportunities

- T004-T006 can run in parallel after setup
- T008 and T009 can proceed in parallel within User Story 1
- T013 and T014 can run independently once the docs and generation flows are wired
- T021-T023 can proceed in parallel once the constitution and plan template updates are scoped

## Implementation Strategy

### MVP First

1. Confirm the drift and target files
2. Establish the code-first OpenAPI builder and generation script
3. Protect the generated contract with tests and artifact regeneration
4. Validate the generated contract before adding process/governance changes

### Incremental Delivery

1. Replace the manual contract source with a code-first builder
2. Generate and validate repository artifacts
3. Expose the generated contract from the backend
4. Update Speckit and governance so future changes stay on the same path

### Parallel Team Strategy

With multiple engineers:

- Engineer A: route schema exports and OpenAPI builder
- Engineer B: generation script, package wiring, generated artifacts, and docs exposure
- Engineer C: contract tests, retroactive Speckit artifacts, constitution, and prompt/template updates

