# Tasks: Model and Embedding Usage Visibility

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, and
`contracts/usage-details.md`

**Tests**: Backend tests are written and observed failing before their matching
implementation. Frontend unit tests cover non-visual API/formatting logic;
Playwright covers the dashboard journey.

## Phase 1: Design and test setup

- [x] T001 Complete approved spec, independent review, research, data model,
  endpoint contract, quickstart, and implementation plan under
  `specs/955-usage-model-telemetry-tab/`.
- [x] T002 [P] Add failing reasoning propagation assertions in
  `backend/tests/unit/model-inference-pipeline.test.ts`.
- [x] T003 [P] Add failing ledger migration/recorder assertions for
  `reasoning_tokens`, `event_kind`, and ambiguous historical rows in
  `backend/tests/integration/usage-ledger-migration.integration.test.ts`.
- [x] T004 [P] Add a failing directive-coherence attribution test in the
  focused authored-directive/dependency test area.
- [x] T005 [P] Add failing detail-route contract tests in
  `backend/tests/contract/usage-details.contract.test.ts`.
- [x] T006 [P] Add failing real-Postgres detail-report integration tests in
  `backend/tests/integration/usage-details.integration.test.ts`.

## Phase 2: Ledger and attribution foundation

- [x] T007 Add migration
  `backend/src/db/migrations/134_usage_event_detail_dimensions.sql` for
  nullable `reasoning_tokens`, non-null kind with evidence-only historical
  classification, and the account/time/id index.
- [x] T008 Extend `packages/usage-contract/usageEvent.d.ts`,
  `backend/src/shared/infra/llm/modelInferencePipeline.ts`, and
  `backend/src/shared/infra/usage/durableUsageEventRecorder.ts` so model and
  embedding recorder paths persist their kind and nullable reasoning count.
- [x] T009 Thread real workspace/agent invocation context through
  `packages/conversation-contract/index.d.ts`,
  `packages/conversation-defaults/src/directiveCoherence.ts`,
  `backend/src/modules/agents/services/authoredDirectiveService.ts`, and
  `backend/src/app/server/dependencies.ts` without making the generic model
  gateway depend on database types.
- [x] T010 Regenerate `backend/src/db/schema.sql` and
  `backend/src/shared/infra/kysely/schema.ts` from migrations.
- [x] T011 Run T002–T004 focused tests and confirm they pass after the
  foundation implementation.

## Phase 3: User Story 1 — Explain a visitor message's AI usage (P1)

**Goal**: One row per qualifying user message shows correct model reasoning
math and a separate query-embedding subtotal.

**Independent test**: Seed a user turn with several model calls, a
message-linked embedding, and mixed reasoning availability; verify one complete
aggregate before pagination.

- [x] T012 [US1] Define `UsageDetailsRepositoryPort`, message response types,
  range normalization, cursor codec, and coverage helpers in
  `backend/src/modules/reporting/contracts/index.ts` and focused new reporting
  modules.
- [x] T013 [US1] Implement the allowlisted Kysely message aggregation in
  `backend/src/db/repositories/usageDetailsReportingRepository.ts`, including
  joined classification, model-only reasoning coverage, and aggregate-before-
  keyset pagination.
- [x] T014 [US1] Implement `UsageDetailsService` and composition wiring in
  `backend/src/modules/reporting/service.ts` and
  `backend/src/app/composition/builtIn/usageReportingModule.ts`.
- [x] T015 [US1] Add message route validation/handler in
  `backend/src/modules/reporting/routes.ts`, then register its OpenAPI schema
  and path in `backend/src/app/http/openapi/`.
- [x] T016 [US1] Make T005/T006 message assertions pass, including no
  content/request/error fields in the response.

## Phase 4: User Story 2 — Inspect internal model and embedding work (P1)

**Goal**: Internal attempts show model, embedding, and unknown historical work
with correct friendly labels and kind-specific dimensions.

**Independent test**: Seed metadata, agent setup, directive draft/coherence,
operator test/replay, eval, zero-vector embedding failure, and unknown history;
verify each is internal with no fabricated dimensions.

- [x] T017 [US2] Add the safe structured label formatter in
  `backend/src/modules/reporting/usageDetailsLabels.ts` for known pairs and
  generic humanization of new operations.
- [x] T018 [US2] Implement the allowlisted individual internal-event Kysely
  query and time/id keyset pagination in
  `backend/src/db/repositories/usageDetailsReportingRepository.ts`.
- [x] T019 [US2] Add the internal-operations route, endpoint schema, and
  OpenAPI registration alongside the message route.
- [x] T020 [US2] Make T005/T006 internal-event assertions pass, including
  complement classification and kind-specific token/vector behavior.

## Phase 5: User Story 3 — Narrow an investigation safely (P2)

**Goal**: Members can consistently filter either detailed view without data
leakage or offset-pagination drift.

**Independent test**: Request each view through multiple pages with a valid
workspace and then a foreign workspace; validate no duplicate/missing row and
the standard bad-request response.

- [x] T021 [US3] Enforce 90-day dates, 1–100 limits, opaque cursor shape, and
  account-owned workspace validation through the reporting service/routes.
- [x] T022 [US3] Extend integration/contract assertions for cross-account
  rejection, invalid cursors/ranges, and deterministic tie-breaker pagination.
- [x] T023 [US3] Inspect detailed account-scoped query plans after migration;
  document the result in the PR handoff and add only a justified extra index if
  the planned index is insufficient.

## Phase 6: Dashboard and contract artifacts

- [x] T024 [P] Add API client methods and generated-type aliases in
  `frontend/lib/api-account.ts` and `frontend/lib/api-types.ts`; add non-visual
  query/formatting helpers in `frontend/lib/usage-details.ts`.
- [x] T025 Add `frontend/components/dashboard/usage-details-view.tsx` with
  shared date/workspace filters, Messages/Internal operations subtabs, loading,
  empty/error states, badges, unavailable values, and Load more.
- [x] T026 Update `frontend/components/dashboard/usage-view.tsx` to compose
  Overview and AI usage tabs while retaining the existing overview behavior.
- [x] T027 Add `frontend/tests/unit/account-api.test.ts` and
  `frontend/tests/unit/usage-details.test.ts` cases for session request/query
  behavior and token-format semantics.
- [x] T028 Add `frontend/tests/e2e/usage-details.spec.ts` coverage for the tab,
  filters, kind labels, pagination, and absence of message-content rendering.
- [x] T029 Regenerate `backend/openapi.{json,yaml}`, sync
  `typescript-sdk/` and `packages/radioso-mcp-server/` generated artifacts, and
  pass `pnpm run check:api-contracts`.

## Phase 7: Documentation and verification

- [x] T030 Update `docs-portal/content/api/accounts-and-users.mdx`,
  `docs/architecture/usage-event-taxonomy.md`, and `readme.md` with the actual
  endpoints, access/privacy boundary, event kinds, token semantics, and UI.
- [x] T031 Run `git diff --check`, focused backend/frontend tests, schema/API
  drift checks, relevant builds/lint, and the repository local CI command
  appropriate to the final diff.
- [x] T032 Request an independent implementation review, resolve all accepted
  findings, and complete a follow-up review before handoff.

## Dependencies and execution order

T002–T006 must fail before T007–T020 implements the underlying behavior. T007
is required before any Kysely detail query can typecheck. T012–T016 establish
the message response used by the dashboard; T017–T020 add the independent
internal view. T021–T023 harden both. T024–T029 can begin once OpenAPI response
shapes settle. T030–T032 follow complete implementation.
