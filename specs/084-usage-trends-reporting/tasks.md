# Tasks: Usage Trends Reporting

**Input**: Design documents from `/specs/084-usage-trends-reporting/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/usage-trends.md, quickstart.md

**Tests**: Backend TDD is required. Backend unit and contract tests must fail before implementation. Integration tests are added but gated on `INTEGRATION_DATABASE_URL`. Frontend Playwright covers the visible journey; frontend unit tests cover only API/date helpers.

## Phase 1: Setup

**Purpose**: Confirm the feature artifacts and local ownership.

- [X] T001 Verify Speckit artifacts exist in `specs/084-usage-trends-reporting/plan.md`, `research.md`, `data-model.md`, `contracts/usage-trends.md`, and `quickstart.md`
- [X] T002 [P] Create a brief implementation note in `.context/usage-trends-brief.md`

---

## Phase 2: Foundational

**Purpose**: Add failing tests and module shells before implementation.

- [X] T003 [P] Add backend unit tests for UTC period math, range bounds, zero fill, and row merging in `backend/tests/unit/usage-trends-periods.test.ts`
- [X] T004 [P] Add backend unit tests for account filter validation and service orchestration in `backend/tests/unit/usage-trends-service.test.ts`
- [X] T005 [P] Add backend contract tests for `GET /api/v1/account/usage-trends` response shape, active membership access, and invalid filters in `backend/tests/contract/usage-trends.contract.test.ts`
- [X] T006 [P] Add gated database integration tests for multi-day/multi-agent daily/weekly/monthly consistency and filter narrowing in `backend/tests/integration/usage-trends.integration.test.ts`
- [X] T007 Run the new backend tests and record the expected red result in `.context/usage-trends-brief.md`
- [X] T008 Create reporting module exports and contracts in `backend/src/modules/reporting/contracts/index.ts` and `backend/src/modules/reporting/composition.ts`

---

## Phase 3: User Story 1 - See Account Usage Trends Over Time (Priority: P1)

**Goal**: A member can retrieve account-wide usage trends with continuous zero-filled buckets.

**Independent Test**: Unit tests pass for bucket math and contract test returns account-wide trends for a session member.

- [X] T009 [US1] Implement UTC date parsing, bucket generation, 366-bucket bound, zero-fill, and aggregate row merging in `backend/src/modules/reporting/usageTrendsQuery.ts`
- [X] T010 [US1] Implement conversation/message/token aggregate SQL builders in `backend/src/modules/reporting/usageTrendsQuery.ts`
- [X] T011 [US1] Implement `UsageTrendsService` account-wide orchestration in `backend/src/modules/reporting/service.ts`
- [X] T012 [US1] Implement thin route validation and presenter in `backend/src/modules/reporting/routes.ts`
- [X] T013 [US1] Register the OSS reporting route through `backend/src/app/composition/builtIn/usageReportingModule.ts` and `backend/src/app/composition/defaultComposition.ts`
- [X] T014 [US1] Run backend usage-trends unit and contract tests and update `.context/usage-trends-brief.md`

---

## Phase 4: User Story 2 - Filter Trends by Workspace and Agent (Priority: P1)

**Goal**: A member can narrow all metrics by account-owned workspace and/or agent, and cross-account filters are rejected.

**Independent Test**: Unit tests prove validation rejects foreign filters; integration fixtures prove filter narrowing.

- [X] T015 [US2] Implement workspace and agent ownership validation SQL in `backend/src/modules/reporting/usageTrendsQuery.ts`
- [X] T016 [US2] Wire filter validation and filtered query parameters in `backend/src/modules/reporting/service.ts`
- [X] T017 [US2] Ensure token SQL excludes unjoinable events under `agentId` and documents this behavior in code/docs via `backend/src/modules/reporting/usageTrendsQuery.ts`
- [X] T018 [US2] Run backend usage-trends unit and contract tests and update `.context/usage-trends-brief.md`

---

## Phase 5: User Story 3 - Choose Daily, Weekly, or Monthly Granularity (Priority: P2)

**Goal**: Daily, weekly, and monthly buckets are UTC and internally consistent.

**Independent Test**: Period math tests and integration fixtures compare daily sums to coarser buckets.

- [X] T019 [US3] Complete weekly and monthly bucket alignment and inclusive range handling in `backend/src/modules/reporting/usageTrendsQuery.ts`
- [X] T020 [US3] Run backend period/unit/contract tests and update `.context/usage-trends-brief.md`

---

## Phase 6: OpenAPI Contract

**Purpose**: Publish the code-first HTTP contract.

- [X] T021 [P] Add usage-trends OpenAPI schemas in `backend/src/app/http/openapi/schemas/usageTrendSchemas.ts`
- [X] T022 Register schemas and path for `GET /api/v1/account/usage-trends` in `backend/src/app/http/openapi/openApiRegistry.ts`, `backend/src/app/http/openapi/openApiPaths.ts`, and `backend/src/app/http/openapi/paths/accountPaths.ts`
- [X] T023 Regenerate `backend/openapi.yaml` and `backend/openapi.json` with `cd backend && pnpm run generate:openapi`
- [X] T024 Run `cd backend && pnpm run test:contract -- usage-trends.contract.test.ts openapi.contract.test.ts`

---

## Phase 7: Frontend Usage Trends View

**Purpose**: Add the member-facing dashboard surface.

- [X] T025 [P] Add usage trend API types and adapter in `frontend/lib/api-types.ts` and `frontend/lib/api-account.ts`
- [X] T026 [P] Add frontend usage-trend date/query/totals helpers and unit tests in `frontend/lib/usage-trends.ts` and `frontend/tests/unit/usage-trends.test.ts`
- [X] T027 Implement the trends controls and series presentation in `frontend/components/dashboard/usage-trends-view.tsx`
- [X] T028 Wire the trends component into `frontend/components/dashboard/usage-view.tsx` without merging it into the EE quota summary
- [X] T029 Add Playwright coverage for the Account > Usage trends journey in `frontend/tests/e2e/usage-trends.spec.ts`
- [X] T030 Run focused frontend unit tests and note Playwright status in `.context/usage-trends-brief.md`

---

## Phase 8: Docs and Final Verification

**Purpose**: Complete docs parity and required verification.

- [X] T031 Update account/API or dashboard docs for usage trends, UTC buckets, bounds, and agent-filtered token attribution in `docs/`
- [X] T032 Run `cd backend && pnpm run build`
- [X] T033 Run `cd backend && pnpm run test:unit`
- [X] T034 Run `cd backend && pnpm run test:contract`
- [X] T035 Run `cd frontend && pnpm run build`
- [X] T036 Run `cd frontend && pnpm run lint`
- [X] T037 Run added frontend unit tests in `frontend/tests/unit/usage-trends.test.ts`
- [X] T038 Write `.context/codex-result.md` with plan summary, changed files, tests, command results, deviations, and unverifiable gaps

---

## Dependencies & Execution Order

- Phase 1 must complete before tests and implementation.
- Phase 2 test tasks must complete before backend implementation.
- US1 creates the endpoint foundation for US2 and US3.
- OpenAPI follows backend route/schema stabilization.
- Frontend follows backend API shape.
- Docs and final verification run last.

## Parallel Opportunities

- T002-T006 can run in parallel because they touch separate files.
- T021 and T025-T026 can run in parallel after the backend response shape is stable.
- Final build/test commands are sequential for clear failure reporting.

## Implementation Strategy

1. Establish failing backend tests.
2. Implement the reporting module and route to green.
3. Add OpenAPI and generated artifacts.
4. Add frontend adapter, helpers, view, and tests.
5. Update docs and run required verification.
