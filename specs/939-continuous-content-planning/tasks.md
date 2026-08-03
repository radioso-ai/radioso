# Tasks: Audience Pulse v1

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), and [contract direction](./contracts/audience-pulse.md).

**Tests**: Backend tasks follow TDD: focused failing tests are written before their
production behavior. Visible UI behavior is covered by Playwright.

## Phase 1: Scope and design

- [x] T001 Record the approved replacement specification and requirements checklist in
  `specs/939-continuous-content-planning/`.
- [x] T002 Discuss the specification with an independent reviewer and integrate the
  population, privacy, locking, and module-boundary feedback into `spec.md`.
- [x] T003 Produce the constitution-aware plan, research, data model, contract direction,
  and local verification guide in `specs/939-continuous-content-planning/`.

## Phase 2: Foundational backend seams (blocking)

**Purpose**: Create the narrow reusable seams without putting Audience Pulse policy in
Quality, generic auth, or generic inference code.

- [x] T004 [P] Add failing route/middleware tests for cookie-only workspace resolution,
  bearer rejection before permission/rate/service work, and account/workspace rate-limit
  subject construction in `backend/tests/unit/audiencePulse/audience-pulse-routes.test.ts`.
- [x] T005 [P] Add failing pure-domain tests for typed content-gap eligibility, duplicate
  theme membership, recommendation evidence subset/recurrence, and server-derived count
  projection in `backend/tests/unit/audiencePulse/audience-pulse-report.test.ts`.
- [x] T006 [P] Add failing repository/integration tests for revisioned replace, full
  prompt-evidence refs, conditional invalidation, and stale-read-versus-refresh behavior
  in `backend/tests/integration/audiencePulse/audience-pulse-snapshot.integration.test.ts`.
- [x] T007 [P] Add failing Chat history-source tests for UTC population, channel/source
  exclusions, `(created_at,id)` order, next-user cutoff, `analysisEnd` cutoff, human
  replies, and typed outcome classification in
  `backend/tests/unit/audiencePulse/audience-pulse-history-source.test.ts`.
- [x] T008 Implement `requireDashboardWorkspaceSession` and a code-owned
  `audiencePulseRefreshRateLimiter` under `backend/src/app/http/middleware/`, with safe
  rate-limit audit context.
- [x] T009 Extract a generic contextual structured-inference factory in
  `backend/src/shared/infra/llm/contextualGateways.ts` that accepts caller-provided
  `ModelCallUsageContext`, retaining no Audience Pulse-specific rule.
- [x] T010 Add migration `backend/src/db/migrations/134_audience_pulse_snapshots.sql`,
  regenerate the database schema type/snapshot, and implement
  `backend/src/db/repositories/audiencePulseSnapshotRepository.ts` with revisioned
  find/replace/conditional-invalidate.
- [x] T011 Implement the Postgres replica-safe run-gate adapter with a non-blocking
  session advisory lease on a pinned Kysely connection, idempotent release, and
  crash-safe connection semantics in `backend/src/modules/audiencePulse/infra/`.
- [x] T012 Implement and export the Chat-owned `AudiencePulseHistorySource` and source
  rehydrator in `backend/src/modules/chat/audiencePulseHistorySource.ts` without giving
  Audience Pulse direct repository access.

**Checkpoint**: The auth, inference, snapshot, lock, and history seams build and their
focused tests are green before report orchestration starts.

## Phase 3: User Story 1 — request and reuse a saved pulse (P1)

**Goal**: Explicitly generate one bounded report or load the existing report without a
provider call on GET.

- [x] T013 [US1] Add failing service tests for no traffic, one provider call, usage
  reserve/commit/release paths, provider/validation failure preservation, busy/rate/usage
  outcomes, audit/telemetry safety, and GET zero-call behavior in
  `backend/tests/unit/audiencePulse/audience-pulse-service.test.ts`.
- [x] T014 [US1] Implement Audience Pulse contracts, service, structured prompt renderer,
  and `backend/prompts/audience-pulse.md` in `backend/src/modules/audiencePulse/`.
- [x] T015 [US1] Add failing HTTP contract tests for session-only GET/POST response
  variants and 409/429 responses in
  `backend/tests/contract/audiencePulse/audience-pulse.contract.test.ts`.
- [x] T016 [US1] Implement routes, presenter/schema, built-in application module, default
  composition registration, code-first OpenAPI schemas/paths, and regenerated OpenAPI
  artifacts for `/api/v1/quality/audience-pulse`.

**Checkpoint**: A session operator can create and reload one snapshot; bearer access and
duplicate/capacity refresh paths are safely rejected.

## Phase 4: User Stories 2 and 3 — themes, gaps, and recommendations (P1)

**Goal**: Show server-derived topics and only evidence-backed actionable opportunities.

- [x] T017 [P] [US2] Add failing service/report tests for exact weekly totals, deterministic
  sampling disclosure, model-output validation, one-theme membership, and sample pulse
  derivation in `backend/tests/unit/audiencePulse/audience-pulse-report.test.ts`.
- [x] T018 [P] [US3] Add failing tests that only qualifying typed retrieval outcomes from
  two conversations yield a content gap/recommendation in
  `backend/tests/unit/audiencePulse/audience-pulse-recommendations.test.ts`.
- [x] T019 [US2] Implement deterministic sample selection, JSON-schema parsing, model
  output validation, and server-owned theme projection in `backend/src/modules/audiencePulse/`.
- [x] T020 [US3] Implement content-gap/recommendation projection and full-prompt-source
  rehydration; when any source fails, conditionally invalidate/re-read rather than return
  a partial report.

**Checkpoint**: Themes remain discussion signals; gaps/recommendations are truthfully
limited to the typed, recurring, verified evidence rule.

## Phase 5: User Story 4 — dashboard and document handoff (P1, delayed)

**Goal**: Render the decision dashboard and seed the canonical document composer without
writing a document.

> Claude must not start this phase before `2026-08-03T00:12:33.153Z`.

- [x] T021 [US4] Add/extend frontend API adapter and dashboard route state in
  `frontend/lib/api-audience-pulse.ts` and `frontend/lib/dashboard-routes.ts`.
- [x] T022 [US4] Add Audience Pulse navigation/view integration in
  `frontend/components/dashboard/{dashboard-shell,app-sidebar}.tsx` and implement
  `frontend/components/dashboard/audience-pulse-view.tsx` with accessible loading,
  initial, no-traffic, completed, refresh-failed, busy, rate/usage-limit, and
  workspace-switch states.
- [x] T023 [US4] Implement account/workspace-keyed one-shot `sessionStorage` draft seed
  consumption/clearing in `frontend/components/dashboard/documents-view.tsx`, mapping
  title and Markdown question bullets into the existing required form fields.
- [x] T024 [US4] Add Playwright coverage for saved-read/no-new-provider UI behavior,
  evidence navigation, Start draft mapping/no URL leak/no write, cancellation, and
  workspace mismatch in `frontend/tests/e2e/audience-pulse.spec.ts`.

## Phase 6: Verification, documentation, and review

- [x] T025 Regenerate/check database schema and code-first OpenAPI outputs; run focused
  backend unit, contract, and integration suites plus `backend` build.
- [x] T026 Update `readme.md` (following `docs/document-writer-prompt.md`) with the
  fixed Audience Pulse refresh budget.
- [x] T027 Run frontend lint/build and the focused Audience Pulse Playwright suite.
- [x] T028 Run `./run-dev.sh` and complete the browser walkthrough in `quickstart.md`
  against localhost; capture the result and any fixes in `.context/`.
- [x] T029 Request an independent code review after localhost verification; address
  actionable feedback and repeat for at most three total review/fix cycles.
- [x] T030 Run `pnpm run ci:local -- origin/main`, inspect `git diff origin/main...`,
  commit intentionally, push the existing branch, and create a pull request targeting
  `main`.

## Dependencies and execution order

- T004–T007 precede T008–T012; these foundational seams block all feature behavior.
- T013–T016 depend on T008–T012.
- T017–T020 depend on T014 and the snapshot/history seam.
- T021–T024 begin only at the specified Claude deadline and consume the settled API
  contract; they may run while remaining backend tests are finishing.
- T025–T030 follow both backend and frontend completion.

## Parallel opportunities

- T004–T007 can be written independently because they target separate boundary tests.
- T017 and T018 can run in parallel after the shared report contracts exist.
- At the permitted deadline, T021–T024 can be delegated to Claude while backend work
  completes, provided backend contract changes are not made without coordination.
