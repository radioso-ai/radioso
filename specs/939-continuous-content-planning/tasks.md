# Tasks: Continuous Content Planning

**Input**: approved documents in `/specs/939-continuous-content-planning/`
**Prerequisites**: approved spec, plan, research, data model, HTTP contract, quickstart

Backend tests are strict red steps and must be observed failing before their paired
production tasks. Visible frontend behavior is Playwright-first; frontend unit tests
cover only API/route/state/formatting transforms.

**Ownership**:

- `[Codex]` — backend, shared conversation/retrieval packages, schema, public
  contracts/generated outputs, docs, integration, review, and delivery.
- `[Claude-FE]` — `frontend/**` only, after T030 locks the HTTP contract.
- A task marked `[P]` may run concurrently only when its files and prerequisites do
  not overlap another active task.

## Phase 1: Setup and approved design

- [X] T001 [Codex] Verify approval, install the frozen pnpm workspace, build workspace dependencies, and run the focused Chat/Retrieval/Quality/composition baseline (116 tests passing)
- [X] T002 [Codex] Record architecture research, thresholds, observability, and the no-impact AMQP/document-worker review in `research.md`
- [X] T003 [Codex] Produce `plan.md`, `data-model.md`, `contracts/http-api.md`, and `quickstart.md` and re-check the constitution gates
- [X] T004 [Codex] Create/update `.context/continuous-content-planning.md` with exact ownership, active test evidence, and Claude handoff constraints

## Phase 2: Foundational neutral contracts and persistence

**Purpose**: establish capability-neutral producer seams and durable storage before any
topic or UI behavior consumes them.

- [X] T005 [Codex] Write failing contract/unit tests for the six `ConversationInteractionRole` values, strict fused/staged parsing, malformed-to-unresolved behavior, and content-free trace propagation in `packages/conversation-contract/`, `packages/conversation-engine/tests/`, and `backend/tests/unit/conversation-interaction-role.test.ts`
- [X] T006 [Codex] Add the neutral interaction contract to `packages/conversation-contract/index.d.ts` and propagate enum-only metadata through `packages/conversation-engine/src/`; extend both Chat parsers/provider schemas and prompt assets in `backend/src/modules/chat/services/{turnPlanService,conversationTurnInterpreter}.ts` and `backend/prompts/chat/{turn-planning,turn-interpretation}.md`
- [X] T007 [Codex] Write failing Chat lifecycle tests for social/control/routine/clarification overrides, substantive follow-ups, earlier clarification source identity, and unresolved expiry in `backend/tests/unit/chat-content-planning-observation.test.ts`
- [X] T008 [Codex] Implement a focused interaction resolver and neutral committed-turn envelope under `backend/src/modules/chat/services/`, retaining it on `PreparedSession` through `chatTurnAssembly.ts` without adding topic/report rules to Chat
- [X] T009 [Codex] Write failing deterministic and agentic retrieval tests for all successfully searched distinct semantic vector envelopes, embedding-space identity, branch caps, failures, and multi-subquery deduplication in `backend/tests/unit/retrieval-semantic-vector-envelope.test.ts`
- [X] T010 [Codex] Add consumer-neutral semantic vector envelopes to `backend/src/modules/retrieval/domain/`, deterministic candidate retrieval/results, and agentic semantic-search collection; export only the internal neutral type through `retrieval/public.ts`
- [X] T011 [Codex] Write failing migration/repository integration tests for workspace isolation, constraints, cascades, dual-space vectors, claims, memberships, redirects, enrichment fences, and topic-document links in `backend/tests/integration/content-planning-persistence.integration.test.ts`
- [X] T012 [Codex] Add concurrent prerequisite indexes in migrations 134–135 and the content-planning schema in `backend/src/db/migrations/136_content_planning.sql`; regenerate `backend/src/db/schema.sql` and `backend/src/shared/infra/kysely/schema.ts`
- [X] T013 [Codex] Define focused Content Planning domain/port types under `backend/src/modules/contentPlanning/contracts/` and add pgvector/claim helpers under `backend/src/shared/infra/kysely/sqlHelpers.ts`
- [X] T014 [Codex] Implement Kysely row mappers/repositories under `backend/src/db/repositories/contentPlanning*.ts`, including idempotent intake, leases, revision fences, generation promotion, redirect lookup, invalidation, and bounded source hydration
- [X] T015 [Codex] Write failing transactional persistence tests proving assistant message/audit/intake/vector atomicity, duplicate idempotency, zero provider calls, and bounded intake behavior in `backend/tests/integration/content-planning-turn-intake.integration.test.ts`
- [X] T016 [Codex] Inject the neutral writer into `PostgresAssistantTurnPersistence`, build the envelope in Chat lifecycle, and wire the Content Planning adapter through `backend/src/app/server/dependencyBuilders.ts`; no clustering/provider work is permitted on this path

**Checkpoint**: committed turns durably register reusable vectors or typed missing-
embedding work without Chat/ Retrieval importing Content Planning.

## Phase 3: User Story 3 — Conversational fragments are classified correctly (P1)

**Goal**: observe information needs rather than every visitor message.

**Independent test**: multilingual fresh questions, follow-ups, acknowledgements,
choices, social turns, routine values, resolved/abandoned clarifications, mixed polite
questions, and ambiguous fragments produce the exact source identities and states.

- [X] T017 [Codex] [US3] Add the failing multilingual interaction fixture and end-to-end intake assertions in `backend/tests/unit/content-planning-interaction-fixture.test.ts`
- [X] T018 [Codex] [US3] Implement Content Planning eligibility/finalization policy in `backend/src/modules/contentPlanning/domain/observationEligibility.ts` and `services/observationIntakeService.ts`
- [X] T019 [Codex] [US3] Add failing replay/bootstrap source tests proving canonical turn metadata/audit lookup, hash validation, no raw fragment embedding, and next-turn unresolved resolution in `backend/tests/unit/content-planning-source-resolution.test.ts`
- [X] T020 [Codex] [US3] Implement bounded message-owned semantic intent loading and historical source resolution without retaining question text in projection rows

## Phase 4: User Story 4 — Continuous incremental projection (P1)

**Goal**: near-current, idempotent assignment with reuse, fallback, provisional topics,
bootstrap, and safe embedding-space changes.

**Independent test**: a reused-vector turn, fallback-vector turn, mature match,
non-match, duplicate delivery, worker restart, budget pause, and space change converge
to one coherent projection without delaying the answer.

- [X] T021 [Codex] [US4] Write failing pure domain tests for cosine assignment, cohesion guard, centroid update, maturity, merge, transitive redirect/cycle protection, expiry, retirement, and policy versions in `backend/tests/unit/content-planning-topic-policy.test.ts`
- [X] T022 [Codex] [US4] Implement pure topic lifecycle/assignment policies under `backend/src/modules/contentPlanning/domain/`
- [X] T023 [Codex] [US4] Add the failing deterministic 160-observation multilingual clustering fixture and F1 gates in `backend/tests/fixtures/content-planning/` and `backend/tests/unit/content-planning-clustering-fixture.test.ts`
- [X] T024 [Codex] [US4] Tune/lock policy version 1 thresholds against the fixture without adding language keywords or provider calls
- [X] T025 [Codex] [US4] Write failing worker tests for bounded embedding batches, vector reuse, typed retries, lease expiry, duplicate claims, stale claim protection, incremental assignment, reconciliation, and safe metrics/log/trace attributes in `backend/tests/unit/content-planning-worker.test.ts`
- [X] T026 [Codex] [US4] Implement focused embedding, assignment, reconciliation, retention, and observability services plus `backend/src/modules/contentPlanning/worker.ts`
- [X] T027 [Codex] [US4] Write failing integration tests for 60-day bootstrap cursor atomicity, per-workspace budget pause/resume, processed/total progress, dual-generation reprojection, consistency gate, and atomic coherent handoff in `backend/tests/integration/content-planning-projection.integration.test.ts`
- [X] T028 [Codex] [US4] Implement bootstrap/reprojection orchestration and budget policy; expose/start/stop the worker only through `backend/src/app/server/{dependencies,types,dependencyBuilders}.ts` and `backend/src/runtime/startWorkerRuntime.ts`
- [X] T029 [Codex] [US4] Add composition and runtime lifecycle tests in `backend/tests/unit/{default-composition,content-planning-worker-runtime}.test.ts`

## Phase 5: User Stories 1 and 2 — Ranking, coverage, and locked HTTP contract (P1)

**Goal**: backend owns exact rolling counts, honest grounding denominators, trends,
credible opportunity ordering, and action evidence.

**Independent test**: seeded current/comparison topics reconcile with Quality and
produce exactly one top recommendation, while healthy/unevaluated/low-volume topics
remain honest.

- [X] T030 [Codex] [US1] [US2] Lock the DTOs and Zod design contract from `contracts/http-api.md` in `backend/src/modules/contentPlanning/contracts/index.ts` and notify Claude that frontend implementation may begin
- [X] T031 [Codex] [US2] Write failing Quality evidence-source tests for canonical population, newer-negative-feedback reopening, active triage, passing Eval exclusion, grounding snapshots, cursor paging, and existing turn mapping in `backend/tests/unit/quality-content-planning-evidence.test.ts` and `backend/tests/integration/content-planning-quality-evidence.integration.test.ts`
- [X] T032 [Codex] [US2] Implement/export the focused read-only Quality evidence policy/source in `backend/src/modules/quality/contentPlanningEvidence.ts` and its cross-table adapter without changing existing Quality service responsibility
- [X] T033 [Codex] [US2] Write failing pure window/count/trend/evidence tests, including distinct report messages, per-topic deduplication, separate `not_evaluated`, and low-denominator states in `backend/tests/unit/content-planning-aggregation.test.ts`
- [X] T034 [Codex] [US2] Implement rolling-window, demand, grounding, trend, and evidence-strength policy under `backend/src/modules/contentPlanning/domain/`
- [X] T035 [Codex] [US1] Write failing opportunity/ranking/action tests covering all four actions, corpus-unavailable, related-content timing/retrieval/citation evidence, stable tie-breaks, and top-card/list parity in `backend/tests/unit/content-planning-opportunity.test.ts`
- [X] T036 [Codex] [US1] Implement opportunity eligibility, ranking version 1, deterministic action policy, and priority reason presentation under `backend/src/modules/contentPlanning/domain/`
- [X] T037 [Codex] [US1] [US2] Write failing list/detail/member-turn route and integration tests for auth, workspace isolation, cursor freezing, merged canonical response, 404 parity, N+1 avoidance, response states, and Quality DTO reuse in `backend/tests/unit/content-planning-routes.test.ts` and `backend/tests/integration/content-planning-read-model.integration.test.ts`
- [X] T038 [Codex] [US1] [US2] Implement focused read queries/presenter/service and `backend/src/modules/contentPlanning/routes.ts`; register the standalone application module at `/api/v1/quality/content-plan`
- [X] T039 [Codex] [US1] [US2] Add code-first schemas/paths and contract tests in `backend/src/app/http/openapi/{schemas,paths}/contentPlanning*.ts`, registries, and `backend/tests/contract/openapi.contract.test.ts`
- [X] T040 [Codex] [US1] [US2] Generate backend OpenAPI and SDK/MCP types, run `pnpm run check:api-contracts`, and hand Claude the final generated shape; confirm again that no MCP tool or AMQP payload was added

## Phase 6: User Stories 1, 2, 5, and 6 — Frontend report (Claude) (P1/P2)

**Goal**: a polished, evidence-first Content plan integrated with existing operator
workflows, not merely API endpoints.

**Independent test**: from a desktop or narrow viewport, the operator identifies the
next action, understands demand/coverage/freshness, inspects evidence, and enters the
appropriate Quality/Knowledge flow with a valid return path.

- [X] T041 [Claude-FE] [US1] [US2] Write failing non-visual adapter/route tests in `frontend/tests/unit/api-content-plan.test.ts` and `frontend/tests/unit/dashboard-routes.test.ts` for list/detail/turn requests, canonical URLs, invalid UUIDs, merged replacement, handoffs, workspace retargeting, and stale-request protection
- [X] T042 [Claude-FE] [US1] [US2] Implement `frontend/lib/api-content-plan.ts`, `frontend/lib/content-plan.ts`, exports, and typed route state in `frontend/lib/dashboard-routes.ts` without duplicating backend rankings/actions/rates
- [X] T043 [Claude-FE] [US1] [US2] Add Content plan under Activity navigation and render `ContentPlanView` through `activity-tabs.tsx`, `area-subnavs.tsx`, `app-sidebar.tsx`, and `dashboard-shell.tsx`
- [X] T044 [Claude-FE] [US1] [US2] Build the decision-first summary, singular Recommended next, segmented opportunities/all-interests views, ranked selectable rows, Emerging section, skeletons, and all honest empty/partial/freshness states under `frontend/components/dashboard/content-plan/`
- [X] T045 [Claude-FE] [US2] [US6] Implement accessible three-verdict grounding composition with `notEvaluated` separate, raw-count low-volume presentation, non-color meaning, screen-reader labels, and quiet processing/degradation announcements
- [X] T046 [Claude-FE] [US5] Implement shareable desktop two-pane and narrow full-width detail, canonical merged URL replacement, list scroll/focus restoration, evidence-first order, source ConversationDrawer, related documents, affected agents/channels, and Copy brief live announcements
- [X] T047 [Claude-FE] [US5] Add topic-scoped Quality handoff using the member-turn endpoint, reuse existing answer rows/triage/Eval/ConversationDrawer behavior, and show an explicit return to the selected Content plan topic
- [X] T048 [Claude-FE] [US5] Add related-document Knowledge handoff/return and authorized topic-driven inline document prefill containing only suggested title plus question outline; preserve normal review/save/import/crawl/connector behavior
- [X] T049 [Claude-FE] [US1] [US2] [US5] [US6] Write Playwright coverage in `frontend/tests/e2e/content-plan.spec.ts` for ranking/top-card parity, desktop/narrow selection and deep links, focus/keyboard/200% zoom, all specified states, conversation/Quality/Knowledge handoffs, question-only draft, and stale workspace responses; update `nav-sidebar.spec.ts`
- [X] T050 [Claude-FE] [US1] [US2] [US5] [US6] Update `frontend/components/dashboard/README.md`; run focused frontend unit tests, Playwright, lint, and build; report changed files and results to Codex

## Phase 7: User Stories 1, 5, and 6 — Enrichment, corpus evidence, and resilience (P2)

**Goal**: labels/briefs help navigation and remediation without controlling evidence or
inventing facts; partial failures and deletion remain trustworthy.

- [X] T051 [Codex] [US1] [US6] Write failing prompt renderer/parser tests for bounded untrusted samples, strict output, prompt injection, no tools, question-only briefs, fact-verification warning, and provider-failure redaction in `backend/tests/unit/content-planning-enrichment.test.ts`
- [X] T052 [Codex] [US1] [US6] Add `backend/prompts/content-planning/{topic-label,content-brief}.md`, structured gateway adapters, validation, and safe failure mapping
- [X] T053 [Codex] [US1] [US5] Write failing corpus evidence tests for top-five authorized documents, relevance floor, pre-gap/change timing, retrieved/cited evidence, deletion, and stale invalidation in `backend/tests/unit/content-planning-corpus-evidence.test.ts`
- [X] T054 [Codex] [US1] [US5] Implement the corpus-evidence adapter and normalized topic-document persistence without treating similarity as completeness
- [X] T055 [Codex] [US1] [US6] Write failing scheduler tests for material-change rules, five-minute debounce, top-ten cap, outside-cap state, retries, and stale revision rejection in `backend/tests/unit/content-planning-enrichment-scheduler.test.ts`
- [X] T056 [Codex] [US1] [US6] Implement enrichment scheduling/publishing and integrate bounded jobs into the Content Planning worker
- [X] T057 [Codex] [US6] Write failing deletion/retention integration tests proving immediate source text/vector/member removal, centroid/representative recomputation, enrichment clearing, provisional retirement, document invalidation, and 90-day redirects in `backend/tests/integration/content-planning-deletion.integration.test.ts`
- [X] T058 [Codex] [US6] Implement deletion/reconciliation hooks and retention pruning with no cached prompt/output history
- [X] T059 [Codex] [US6] Add observability policy tests proving questions, vectors, labels, recommendations, document content, prompts, completions, provider bodies, and high-cardinality labels never enter logs/metrics/traces/analytics

## Phase 8: Performance, docs, integration, and delivery

- [X] T060 [Codex] Add the 20,000-observation real-Postgres performance fixture and verify coherent summary/first page p95 under two seconds plus bounded query counts in `backend/tests/integration/content-planning-performance.integration.test.ts`
- [X] T061 [Codex] Read `docs/document-writer-prompt.md`, then update operator/API/product docs under `docs/` and `docs-portal/content/` for workflow, freshness, denominators, emerging evidence, limitations, API, privacy, and no manual report generation
- [X] T062 [Codex] Update affected source briefs and `docs/architecture/code-map.md` for Content Planning ownership, Chat interaction metadata, Retrieval vector envelopes, Quality evidence port, worker entry point, focused tests, and frontend entry points
- [X] T063 [Codex] Integrate Claude’s frontend work, resolve contract/type drift without moving domain policy into the client, and run focused backend/frontend suites from `quickstart.md`
- [ ] T064 [Codex] Run schema/type drift, prompt generation checks, OpenAPI/SDK/MCP alignment, architecture validation, backend/frontend builds, clustering F1 gate, performance fixture, Playwright desktop/narrow/accessibility flows, and `pnpm run ci:local -- --all`
- [ ] T065 [Codex] Run up to three senior-engineer review/fix/revalidation loops, covering SQL safety, LLM trust boundaries, idempotency, concurrency, deletion, cross-workspace isolation, and frontend contract fidelity
- [ ] T066 [Codex] Run one engineering-manager review against the approved spec/plan/tasks and address every in-scope finding
- [ ] T067 [Codex] Mark completed tasks, commit intentionally with Conventional Commits, push the current branch without renaming it, and open a PR against `main` with spec, design, validation, fixture/performance results, queue review, and screenshots

## Dependencies and execution order

- T005–T016 are blocking neutral contracts/persistence.
- US3 (T017–T020) finalizes observation semantics before the projection worker consumes them.
- US4 domain/worker (T021–T029) establishes coherent data before reads.
- T030 locks the shared DTO contract. Claude may begin T041–T050 after T030 while
  Codex continues Quality/read APIs and enrichment in disjoint paths.
- T031–T040 establish the server-owned semantics and generated public contract used by frontend integration.
- Enrichment T051–T059 can proceed after topic/read contracts and does not block the
  first evidence-only report, but it blocks the approved complete feature.
- Documentation and broad validation follow contract/runtime/UI stabilization.
- Review, commit, push, and PR are last.

## Parallel opportunities

- After T030, Claude owns only `frontend/**`; Codex owns non-frontend paths.
- Pure aggregation/ranking policy tests can run beside Quality evidence-source tests.
- Prompt/enrichment tests can run beside corpus evidence tests after core topic state exists.
- Docs can begin after HTTP/action semantics stabilize while final Playwright cases run.

## Delivery strategy

The first coherent increment is interaction-aware intake plus incremental topics and an
evidence-only report (US3/US4/US2). The primary product increment adds deterministic
recommendation/action and the complete frontend decision path (US1). Evidence handoffs,
enrichment, deletion, and degraded-state hardening complete US5/US6. No phase introduces
a scheduled report, manual refresh endpoint, automatic publication, or frontend score.
