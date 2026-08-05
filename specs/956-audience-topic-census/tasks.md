# Tasks: Audience Topic Census

**Spec**: `specs/956-audience-topic-census/spec.md`
**Plan**: `specs/956-audience-topic-census/plan.md`
**Created**: 2026-08-04

## Format: `[ID] [P?] [Story] [Tier] Description`

- `[P]` — no shared files with another `[P]` task in the same phase; safe to
  run concurrently.
- `[Story]` — the user story the task serves, or `Setup` / `Foundation` /
  `Polish`.
- `[Tier]` — recommended model tier. `opus` for algorithm design, prompt
  quality, and work with no existing pattern to copy. `sonnet` for
  implementation against an established pattern, tests, wiring, and docs.

## Path Conventions

Package sources under `packages/census/{src,tests}`. Backend sources under
`backend/src`, tests under `backend/tests/{unit,integration,contract}`.
Migrations under `backend/src/db/migrations`. Runtime prompts under
`backend/prompts`.

---

## Phase 1: Setup (Shared Infrastructure)

- **T001** `[P]` `[Setup]` `[sonnet]` Scaffold `packages/census` following
  `packages/conversation-engine`: `package.json` with **no `dependencies`
  block**, single `tsconfig.json` with `rootDir: "src"`, `vitest.config.ts`
  with `environment: "node"`, and empty `src/index.ts`.
- **T002** `[P]` `[Setup]` `[sonnet]` Port the entry-point budget test from
  `packages/conversation-kit/tests/entryPoints.test.ts` plus
  `tests/support/{traceEntry.mjs,entryGraphHook.mjs}`. Set
  `ALLOWED_EXTERNALS = { ".": [] }`. Verify it fails when a dependency is
  added, then passes when removed — a budget test that has never gone red is
  not known to work.
- **T003** `[Setup]` `[sonnet]` Add a `census` bucket to
  `scripts/local-ci-checks.sh` and `.github/workflows/ci.yml`, modeled on the
  `crawler` bucket in both. Path filter `packages/census/*`; job runs
  `pnpm install --filter @radioso/census...`, `build`, `test`. **Without this
  task, T002 never executes in CI** — `packages/*` tests are not otherwise
  run.
- **T004** `[P]` `[Setup]` `[sonnet]` Add `validateCensusImport(record)` to
  `scripts/validate-architecture-boundaries.mjs` and its call site in
  `validateImportRecords`. Rejects any bare specifier that is not `node:*`
  and any relative import resolving outside `packages/census/`.
- **T005** `[P]` `[Setup]` `[sonnet]` Add facet job queue settings to
  `.env.example`, following the existing document job queue variables.

---

## Phase 2: Foundational (Blocking Prerequisites)

- **T006** `[Foundation]` `[sonnet]` Write migration
  `backend/src/db/migrations/137_topic_census.sql` creating `message_facets`,
  `topics`, `topic_memberships`, `topic_transitions`, and
  `facet_extraction_jobs` per the Data section of `plan.md`. Forward-only and
  idempotent (`IF NOT EXISTS`). Partial HNSW index on
  `message_facets.embedding WHERE embedding IS NOT NULL`.
- **T007** `[Foundation]` `[sonnet]` Run `pnpm --dir backend run db:schema`
  and `pnpm --dir backend run db:types`; commit the regenerated
  `backend/src/db/schema.sql` and `backend/src/shared/infra/kysely/schema.ts`.
  Requires Docker. Both have CI drift checks.
- **T008** `[Foundation]` `[sonnet]` Add a cheap-tier structured inference
  factory resolving the `"rewrite"` capability, following
  `ContextualQueryRewriteGateway` in
  `backend/src/shared/infra/llm/contextualGateways.ts`.
  `ContextualStructuredInferenceFactory` is hardcoded to `"chat"` and is not
  reusable here.
- **T009** `[Foundation]` `[opus]` Build the facet job spine: repository over
  `facet_extraction_jobs` with claim/attempt/backoff semantics, an AMQP
  dispatcher and consumer mirroring
  `backend/src/modules/documents/infra/amqpDocumentJobQueue.ts`, a Cloud Tasks
  dispatcher mirroring its sibling, and a poll loop registered in
  `backend/src/runtime/startWorkerRuntime.ts`. Retry policy follows
  `DocumentProcessingWorker.handleFailure` — three attempts, `[1s, 5s, 15s]`,
  permanent-versus-transient classification. No generic job bus exists to
  reuse, so this is design work, not adaptation.
- **T010** `[P]` `[Foundation]` `[sonnet]` Add `messageFacetRepository.ts` and
  `topicRepository.ts` under `backend/src/db/repositories/`, Kysely only,
  constructor-injected `db: Db`, matching `embeddingProfileJobRepository.ts`.

---

## Phase 3: User Story 1 - Trustworthy topic distribution (P1) 🎯 MVP

### Tests for User Story 1 (REQUIRED for backend)

- **T011** `[US1]` `[opus]` Build the facet quality eval fixture in
  `backend/tests/unit/eval-suite`: a few hundred real visitor questions with
  hand-assigned topic labels, including a multilingual subset where one intent
  appears in several languages. Score the produced partition against the
  reference with adjusted Rand index and normalized mutual information.
  Deterministic, so it belongs in the unit eval suite rather than the live
  one. **This gates everything downstream** — if facets do not put one intent
  in one place across languages, the design does not work and should be
  revisited before more is built on it.
- **T012** `[P]` `[US1]` `[sonnet]` Failing unit tests in
  `packages/census/tests/kmeans.test.ts`: identical input yields identical
  output across runs; different seeds converge to the same partition on
  well-separated fixtures; empty and single-point inputs are handled.
- **T013** `[P]` `[US1]` `[sonnet]` Failing unit tests in
  `packages/census/tests/cluster.test.ts`: `k` derivation from
  `target_members`; per-topic radius; points beyond radius reported
  unclassified; clusters below minimum size dissolved to unclassified.
- **T014** `[US1]` `[sonnet]` Failing integration test in
  `backend/tests/integration/audiencePulse/`: an analysis over a seeded
  workspace covers every eligible question, and topic sizes plus unclassified
  equal the window total. Gated on `INTEGRATION_DATABASE_URL` via
  `resolveIntegrationDatabase()`.
- **T015** `[US1]` `[sonnet]` Failing contract test in
  `backend/tests/contract/audiencePulse/`: the report exposes exact counts and
  shares, and coverage reports the full population.

### Implementation for User Story 1

- **T016** `[US1]` `[opus]` Write `backend/prompts/facet-extraction.md` and
  its strict JSON schema: one short, PII-stripped, language-normalized
  statement of what a question asks. This is the load-bearing component of the
  whole design; iterate against T011 until the scores hold.
- **T017** `[US1]` `[sonnet]` Add `backend/src/modules/facets/` with an
  extraction service calling the T008 cheap-tier factory with the T016 prompt,
  a worker handler on the T009 spine, and enqueue on eligible message write.
  Store facet text, prompt version, and embedding profile.
- **T018** `[US1]` `[opus]` Implement `packages/census/src/kmeans.ts`: k-means
  with seeded k-means++ initialization, fixed restart count keeping lowest
  inertia, seed derived from a hash of the input set. Deterministic
  tie-breaking throughout — this is where reproducibility is won or lost.
- **T019** `[US1]` `[opus]` Implement `packages/census/src/cluster.ts`: `k`
  from `target_members` (start at 20), agglomeration of base centroids to the
  top level, per-topic radius as the 90th percentile of member distance, and
  the two unclassified rules.
- **T020** `[US1]` `[sonnet]` Add
  `backend/src/modules/audiencePulse/services/censusService.ts` orchestrating
  read eligible questions, load facets and vectors, call the package, persist
  memberships.
- **T021** `[US1]` `[sonnet]` Narrow `backend/prompts/audience-pulse.md` and
  `services/prompt.ts` to naming a single cluster from exemplars — six nearest
  the centroid, four peripheral. The `evidenceIds` partition, the eight-theme
  ceiling, and the omit-what-does-not-fit escape hatch all retire.
- **T021a** `[US1]` `[sonnet]` Add a cluster audit pass after naming: a model
  reads each generated title and description and rejects any that carries
  identifying detail, so a topic label cannot leak what a facet failed to
  strip. Clio runs this as a distinct fourth privacy layer and the facet
  prompt alone is not an equivalent control — it guards the facet, not the
  label generated from a sample of them. A rejected label is regenerated
  once, then the topic renders with a neutral fallback title.
- **T022** `[US1]` `[sonnet]` Update `domain/report.ts`: topic size as exact
  count and share, `weeklyPulse` computed from population membership rather
  than sampled evidence, `unclassifiedQuestionCount` against the population.
- **T023** `[US1]` `[sonnet]` Retire sampling from
  `backend/src/modules/chat/audiencePulseHistorySource.ts` —
  `selectAudiencePulseSample`, the candidate query, and the sample policy in
  `modules/audiencePulse/contracts.ts`. The file stays a history reader.
- **T024** `[US1]` `[sonnet]` Update
  `frontend/components/dashboard/audience-pulse-view.tsx` and
  `lib/api-audience-pulse.ts`: coverage reads as a census, `asked N×` is
  replaced by an exact count and share.
- **T025** `[US1]` `[sonnet]` Playwright coverage for the changed dashboard
  reading. No assertions on markup, class names, or design tokens.

**Checkpoint**: US1 is independently shippable. Exact counts over the full
population, no identity tracking yet.

---

## Phase 4: User Story 2 - Track a topic over time (P2)

- **T026** `[US2]` `[sonnet]` Failing unit tests in
  `packages/census/tests/identity.test.ts` covering all five transitions:
  survived, split, merged, emerged, dissolved. Include the ambiguous case
  where several pairings pass threshold at once.
- **T027** `[US2]` `[opus]` Implement `packages/census/src/identity.ts`:
  containment ratios in both directions over shared members, thresholds
  `τ_survive` and `τ_part` as typed configuration, maximum-weight bipartite
  matching for ambiguity, and centroid-similarity fallback for
  non-overlapping windows.
- **T028** `[US2]` `[sonnet]` Persist topics and transitions across runs;
  surviving topics keep identifier and label, dissolved topics are retained
  rather than deleted.
- **T029** `[US2]` `[sonnet]` Reuse the stored label for survived topics; name
  only emerged, merged, and split topics.

**Checkpoint**: topics are trackable across analyses.

---

## Phase 5: User Story 3 - Work is never repeated (P3)

- **T030** `[US3]` `[sonnet]` Failing integration test: a repeat analysis with
  no new questions issues zero extraction calls and zero naming calls.
- **T031** `[US3]` `[sonnet]` Skip extraction when a current-version facet
  exists; sweep and re-extract when the prompt version changes; re-embed from
  retained facet text when the embedding profile changes.
- **T032** `[US3]` `[sonnet]` Confirm naming is skipped for survived topics
  end to end.

---

## Phase 6: Polish & Cross-Cutting Concerns

- **T033** `[P]` `[Polish]` `[sonnet]` Observability per the spec's review
  section: extraction outcome and latency, analysis duration split between
  clustering and naming, naming calls issued versus reused, clustering
  iterations and final inertia, transition counts by kind, facet backlog
  depth. Identifiers, counts, and durations only — no facet text, question
  text, labels, or vectors.
- **T034** `[P]` `[Polish]` `[sonnet]` Backfill script enqueuing extraction
  for existing eligible messages, rate-limited so it does not starve document
  processing.
- **T035** `[P]` `[Polish]` `[sonnet]` Update the Audience Pulse section of
  `docs/architecture/code-map.md` with the new package, module, worker job,
  and stores, plus a `Related specs:` pointer here. Update operator-facing
  Audience Pulse docs to describe a census. Follow
  `docs/document-writer-prompt.md`.
- **T036** `[Polish]` `[sonnet]` Graduate `algorithm.md` to
  `docs/architecture/topic-census.md` in present tense describing what exists,
  with the three-key YAML frontmatter, and link it from `docs/README.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6. T003 should land
early in Phase 1; until it does, T002 provides no enforcement.

### User Story Dependencies

US1 depends on Phases 1–2. US2 depends on US1 (identity matches against a
prior run, so a first run must exist). US3 depends on US1 and touches US2's
naming path. Each story is independently shippable in order.

### Within Each User Story

Tests precede implementation, per the constitution. Within Phase 3, T011 is a
gate rather than a step: T016 iterates against it, and a failure there is a
signal to revisit the design rather than to continue.

### Parallel Opportunities

- Phase 1: T001, T002, T004, T005 in parallel; T003 after T001.
- Phase 2: T010 parallel with T008 and T009.
- Phase 3: T012 and T013 in parallel (package tests, no backend dependency);
  T018 and T019 sequential on the same module. T024 and T025 after T022.
- Phase 6: T033, T034, T035 in parallel.

## Parallel Example: Phase 1

```
T001 scaffold package     ─┐
T002 budget test          ─┼─ concurrent
T004 boundary rule        ─┤
T005 env example          ─┘
                           └─▶ T003 CI wiring
```

## Implementation Strategy

**MVP first**: Phases 1–3 deliver the whole point of the feature — exact
counts over the full population. Ship it before starting US2.

**Gate on T011**: the eval fixture is built before the prompt it validates and
before anything that depends on facet quality. This is the one place where a
negative result should stop the plan rather than be worked around.

**Tier assignment**: `opus` on T009, T011, T016, T018, T019, T027 — the job
spine with no pattern to copy, the eval methodology, the prompt that carries
the design, determinism, the unclassified rules, and identity matching.
Everything else is `sonnet` against an established repo pattern.

## Notes

- FR-016 (reweighting the existing sampled report) ships ahead of this work as
  a separate change and is not tracked here.
- `packages/*` tests do not run in CI today. T003 is the difference between a
  boundary that is enforced and one that is merely documented.
- `db:schema` and `db:types` both require Docker and produce committed
  artifacts with CI drift checks. Running them is part of T007, not an
  afterthought.
- The facet store holds no raw question text. Any task that finds itself
  wanting the original question should stop and re-read the spec's privacy
  decision.
