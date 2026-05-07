# Tasks: Skills Catalog Diagnostics

**Input**: Design documents from `/specs/059-skills-catalog-diagnostics/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/skills-catalog.md, quickstart.md

## Phase 1: Setup

- [x] T001 Review existing route, OpenAPI, composition, capability policy, SDK generation, and MCP docs patterns in `backend/src/app/`, `backend/src/shared/domain/capabilityPolicy.ts`, `typescript-sdk/`, and `docs/`

## Phase 2: Foundational

- [x] T002 Add shared skill capability names to `backend/src/shared/domain/capabilityPolicy.ts`
- [x] T003 [P] Add capability policy unit coverage for new skill capability names in `backend/tests/unit/capability-policy.test.ts`
- [x] T004 Add the skills module domain types and default catalog metadata in `backend/src/modules/skills/`
- [x] T005 Add the skills catalog service and diagnostic helpers in `backend/src/modules/skills/`
- [x] T006 Add skills catalog unit coverage in `backend/tests/unit/skills-catalog.test.ts`
- [x] T007 Wire default skills catalog registration through `backend/src/app/composition/` and `backend/src/app/server/`
- [x] T008 Add composition coverage for default skills catalog wiring in `backend/tests/unit/default-composition.test.ts`

## Phase 3: User Story 1 - Discover Supported Skills (P1)

**Goal**: A caller can list supported built-in skills and see which existing product surface owns each skill.

**Independent Test**: `GET /api/v1/skills` returns catalog entries with stable names, purposes, owners, execution classes, availability, and contract references.

- [x] T009 [US1] Add failing contract coverage for `GET /api/v1/skills` in `backend/tests/contract/skills-catalog.contract.test.ts`
- [x] T010 [US1] Add skills route list handling in `backend/src/app/http/routes/skillRoutes.ts`
- [x] T011 [US1] Mount skills routes in `backend/src/app/http/routes/index.ts`
- [x] T012 [US1] Add skills catalog OpenAPI list schemas and route in `backend/src/app/http/openapi/document.ts`
- [x] T013 [US1] Regenerate `backend/openapi.yaml` and `backend/openapi.json`

## Phase 4: User Story 2 - Understand Capability And Surface Fit (P2)

**Goal**: MCP, SDK, and API clients can inspect supported caller surfaces and required capabilities before using current contracts.

**Independent Test**: Catalog entries expose shared capability names, supported caller surfaces, and current contract references without implying generic execution.

- [x] T014 [US2] Extend skills catalog contract coverage for required capabilities and supported caller surfaces in `backend/tests/contract/skills-catalog.contract.test.ts`
- [x] T015 [US2] Add detail route coverage for `GET /api/v1/skills/:skillName` and unknown skill responses in `backend/tests/contract/skills-catalog.contract.test.ts`
- [x] T016 [US2] Add skills route detail handling and stable `skill_not_found` errors in `backend/src/app/http/routes/skillRoutes.ts`
- [x] T017 [US2] Add skills catalog OpenAPI detail and not-found schemas in `backend/src/app/http/openapi/document.ts`
- [x] T018 [US2] Regenerate SDK generated types from OpenAPI into `typescript-sdk/src/generated/`

## Phase 5: User Story 3 - Standardize Skill Diagnostics (P3)

**Goal**: Operators and engineers have a standard diagnostic definition for future deterministic and probabilistic skill executions.

**Independent Test**: Tests and docs show that the diagnostic definition can represent deterministic skills, strategy-aware retrieval, and unsupported or fallback outcomes.

- [x] T019 [US3] Add diagnostic shape validation coverage in `backend/tests/unit/skills-catalog.test.ts`
- [x] T020 [US3] Expose diagnostic supported-field metadata from the skills module in `backend/src/modules/skills/`
- [x] T021 [US3] Include diagnostic schemas in OpenAPI and regenerated artifacts in `backend/src/app/http/openapi/document.ts`, `backend/openapi.yaml`, and `backend/openapi.json`

## Phase 6: Documentation And Cross-Cutting

- [x] T022 Update `docs/radioso-skills-rfc.md` with the concrete catalog and diagnostic definitions
- [x] T023 Update SDK documentation in `docs/typescript-sdk-basic-usage.md` or related SDK docs for skill discovery
- [x] T024 Update MCP documentation in `docs/mcp-client-setup.md` for shared skill vocabulary
- [x] T025 Ensure `docs/README.md` links remain accurate
- [x] T026 Document message-queue no-impact review in `specs/059-skills-catalog-diagnostics/plan.md` or implementation notes
- [x] T027 Run backend unit, contract, build, and SDK build validations from `specs/059-skills-catalog-diagnostics/quickstart.md`
- [x] T028 Request another agent review, address findings, and repeat until no significant findings remain

## Dependencies

- Foundational tasks T002-T008 block all user stories.
- User Story 1 must land before User Story 2 because detail metadata shares list schemas.
- User Story 3 can start after foundational module types exist, but OpenAPI diagnostic exposure depends on User Story 1 schemas.
- Documentation and validation run after user stories are complete.

## Parallel Examples

- T003 can run in parallel with T004 because it touches tests while the module is introduced.
- T009 can be written before T010-T012 to satisfy backend TDD.
- T014 and T015 can be written before T016-T017.
- T022, T023, and T024 can be updated in parallel after API shapes are stable.

## Implementation Strategy

MVP first: complete User Story 1 so catalog listing works through the backend API. Then add detail and capability/surface metadata for User Story 2. Finally standardize diagnostics for User Story 3 and update docs.
