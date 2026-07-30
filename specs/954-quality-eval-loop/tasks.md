# Tasks: Quality Resolution and Eval Learning Loop

**Input**: Design documents from `/specs/954-quality-eval-loop/`
**Prerequisites**: approved spec, plan, research, data model, HTTP contract, quickstart

Backend test tasks are strict red steps and must fail before their paired
production tasks. Visible dashboard behavior is covered by Playwright; frontend
unit tests cover only API/URL/state transforms.

## Phase 1: Setup

- [X] T001 Verify feature checklist, current branch, ignore files, and baseline focused Quality/Eval/frontend tests
- [X] T002 Record the no-impact message-queue review in `specs/954-quality-eval-loop/research.md`

## Phase 2: Foundational data and boundaries

- [X] T003 Write failing migration/schema integration coverage for triage resolution/version/history and Eval association in `backend/tests/integration/quality-eval-learning-loop-migration.integration.test.ts`
- [X] T004 Add migration `backend/src/db/migrations/133_quality_eval_learning_loop.sql` and regenerate `backend/src/db/schema.sql` plus `backend/src/shared/infra/kysely/schema.ts`
- [X] T005 [P] Write failing Quality reason validation tests in `backend/tests/unit/quality-resolution.test.ts`
- [X] T006 [P] Add typed state/reason/note rules in `backend/src/modules/quality/domain/resolution.ts` and exports in `backend/src/modules/quality/composition.ts`
- [X] T007 Define narrow Quality verification and Eval message-association contracts in `backend/src/modules/quality/contracts/index.ts` and `backend/src/modules/eval/domain/types.ts`

## Phase 3: User Story 1 — Close a review with a useful reason (P1)

**Independent test**: structured terminal transitions validate by action, active
transitions reject resolution, `other` requires a note, and both dashboard
surfaces use the same recoverable dialog.

- [X] T008 [US1] Write failing Quality route/service tests for structured closure, legacy input, reopen clearing, and note exclusion in `backend/tests/unit/quality-routes.test.ts` and `backend/tests/integration/quality-turns.integration.test.ts`
- [X] T009 [US1] Implement structured triage mapping and writes in `backend/src/modules/quality/service.ts` and validation/transport in `backend/src/modules/quality/routes.ts`
- [X] T010 [US1] Add shared accessible close-review behavior in `frontend/components/dashboard/quality/close-review-dialog.tsx`
- [X] T011 [US1] Wire terminal actions, details, success announcement, and focus restoration in `frontend/components/dashboard/quality-view.tsx` and `frontend/components/dashboard/needs-attention-view.tsx`
- [X] T012 [US1] Update Quality API types/client and Needs Attention mappings in `frontend/lib/api-quality.ts`, `frontend/lib/needs-attention.ts`, and `frontend/lib/needs-attention-quality.ts`

## Phase 4: User Story 2 — Preserve concurrent decisions (P1)

**Independent test**: two callers using one version produce one accepted write
and one `409` with the current record; history contains accepted transitions in
order.

- [X] T013 [US2] Write failing transition concurrency/history tests in `backend/tests/integration/quality-triage.integration.test.ts` and conflict route tests in `backend/tests/unit/quality-routes.test.ts`
- [X] T014 [US2] Implement conditional versioned transition and atomic audit persistence in `backend/src/modules/quality/service.ts`
- [X] T015 [US2] Add typed conflict response handling in `backend/src/modules/quality/routes.ts`, `frontend/lib/api-quality.ts`, and `frontend/components/dashboard/quality/close-review-dialog.tsx`
- [X] T016 [US2] Extend Needs Attention triage data/pending-state safety in `frontend/lib/needs-attention.ts`, `frontend/hooks/use-needs-attention-activity.ts`, and `frontend/components/dashboard/needs-attention-view.tsx`

## Phase 5: User Story 3 — Add or open the Eval in one action (P1)

**Independent test**: repeated and concurrent PUTs for one assistant message
return one case/snapshot; GET is read-only; wrong-workspace/non-assistant/deleted
cases follow the documented behavior.

- [X] T017 [US3] Write failing Eval message-case service/repository tests in `backend/tests/unit/eval-message-case-service.test.ts` and `backend/tests/integration/eval-repository.integration.test.ts`
- [X] T018 [US3] Refactor snapshot preparation without behavior change in `backend/src/modules/eval/services/evalSnapshotService.ts`
- [X] T019 [US3] Implement atomic association persistence and batch lookup in `backend/src/modules/eval/services/evalRepository.ts`
- [X] T020 [US3] Implement the focused orchestration service in `backend/src/modules/eval/services/evalMessageCaseService.ts` and export it from `backend/src/modules/eval/composition.ts`
- [X] T021 [US3] Write failing Eval route tests, then add GET/PUT message routes in `backend/tests/unit/eval-routes.test.ts` and `backend/src/modules/eval/routes/evalRoutes.ts`
- [X] T022 [US3] Wire the new Eval service in `backend/src/app/server/dependencyBuilders.ts` and `backend/src/app/server/types.ts`
- [X] T023 [US3] Replace client-side capture/create scanning with idempotent Add/Open Eval in `frontend/lib/api-eval.ts` and `frontend/components/dashboard/send-to-eval-action.tsx`

## Phase 6: User Story 4 — See whether a fix has been verified (P2)

**Independent test**: a Quality page receives one batch of current pending,
passing, failing, error, recorded-only, or missing projections and the UI shows
honest timestamped evidence.

- [X] T024 [US4] Write failing Eval batch projection and Quality enrichment tests in `backend/tests/integration/eval-repository.integration.test.ts` and `backend/tests/unit/quality-verification.test.ts`
- [X] T025 [US4] Implement Eval-owned batch projection in `backend/src/modules/eval/services/evalRepository.ts` and `backend/src/modules/eval/services/evalMessageCaseService.ts`
- [X] T026 [US4] Inject the narrow port through `backend/src/app/composition/builtIn/qualityModule.ts` and enrich pages in `backend/src/modules/quality/service.ts`
- [X] T027 [US4] Present Add/Open Eval status, latest-run time, and Review and resolve in `frontend/components/dashboard/quality/eval-verification-action.tsx` and consuming Quality surfaces

## Phase 7: User Story 5 — Learn from closed reviews (P2)

**Independent test**: current terminal rows aggregate and filter by reason with
count/list parity; reopening removes a row; URL state restores and breakdown
clicks through.

- [X] T028 [US5] Write failing Quality reason-filter and breakdown tests in `backend/tests/unit/quality-stats-query.test.ts`, `backend/tests/integration/quality-turns.integration.test.ts`, and `backend/tests/integration/quality-stats.integration.test.ts`
- [X] T029 [US5] Implement reason and distinct terminal-transition-window predicates plus breakdown aggregation in `backend/src/modules/quality/service.ts` and `backend/src/modules/quality/statsQuery.ts`
- [X] T030 [US5] Add reason query validation in `backend/src/modules/quality/routes.ts`
- [X] T031 [US5] Write non-visual URL/API tests and add normalized reason plus terminal-transition-window state in `frontend/tests/unit/dashboard-routes.test.ts`, `frontend/lib/dashboard-routes.ts`, and `frontend/lib/api-quality.ts`
- [X] T032 [US5] Add reason filters, active chips, closed details, and clickable compact breakdown in `frontend/components/dashboard/quality-view.tsx` and `frontend/components/dashboard/quality/resolution-breakdown.tsx`

## Phase 8: Contracts, docs, and cross-cutting validation

- [X] T033 Update code-first schemas/paths and contract tests in `backend/src/app/http/openapi/schemas/qualitySchemas.ts`, `backend/src/app/http/openapi/paths/qualityPaths.ts`, `backend/src/app/http/openapi/paths/evalPaths.ts`, and `backend/tests/contract/openapi.contract.test.ts`
- [X] T034 Regenerate `backend/openapi.{json,yaml}`, TypeScript SDK OpenAPI/types, and MCP OpenAPI types; run `pnpm run check:api-contracts`
- [X] T035 Add Playwright coverage for shared closure, conflict, focus/live announcement, Add/Open Eval, timestamped evidence, URL restoration, and breakdown navigation in `frontend/tests/e2e/quality-resolution.spec.ts`
- [X] T036 Update operator/API docs and affected module briefs in `docs/quality-eval-learning-loop.md`, `docs-portal/content/guides/evals.mdx`, and `backend/src/modules/quality/README.md`
- [X] T037 Run focused suites, backend/frontend builds, schema/type drift checks, architecture validation, and `pnpm run ci:local -- origin/main`; record evidence in the PR body
- [X] T038 Run senior-engineer review loops and apply all in-scope findings
- [X] T039 Run one engineering-manager review and apply all in-scope feedback
- [ ] T040 Commit, push `954-quality-eval-loop`, and open a PR against `main` linking spec, plan, tasks, validation, and issue #940

## Dependencies

- T001–T007 establish the schema and narrow boundaries.
- US1 and US2 share triage persistence and execute in order.
- US3 establishes association identity before US4 consumes its batch projection.
- US5 depends on structured closure timestamps/reasons, not on Eval.
- Contracts/docs/Playwright follow the runtime/UI slices; review and PR creation are last.

## Parallel opportunities

- Quality domain validation and the migration test can be authored independently.
- After foundational contracts, Quality triage and Eval association work touch disjoint module files.
- URL transform tests and backend breakdown tests are independent.
- Documentation can begin after runtime contracts stabilize while Playwright is authored.

## Delivery strategy

P1 is structured/concurrent closure plus idempotent Add/Open Eval (US1–US3).
P2 closes the learning loop with verification and reporting (US4–US5). Each
backend production slice follows its immediately preceding failing tests.
