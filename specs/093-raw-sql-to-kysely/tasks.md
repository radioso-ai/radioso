---
description: "Task list for migrating backend data access from raw SQL to Kysely"
---

# Tasks: Migrate Backend Data Access from Raw SQL to Kysely

**Input**: Design documents from `specs/093-raw-sql-to-kysely/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/README.md, quickstart.md

**Tests**: This is a behavior-preserving refactor. The existing test suite is the
behavioral specification. Per repository: ensure an integration-level safety net is GREEN
on the raw-SQL implementation BEFORE swapping to Kysely (write a characterization test if
coverage is thin), then keep it green after. Negative compile tests are added to prove
type-safety.

**Organization**: Tasks are grouped by user story (US1–US4). Each repository task is
independently shippable because the repository's port is unchanged.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 / US4
- All paths are under `backend/` unless noted.

## Path Conventions

- Backend code: `backend/src/`
- Backend tests: `backend/tests/{unit,integration,contract}/`
- Run one integration test file: `cd backend && pnpm exec vitest run tests/integration/<file>`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add Kysely + codegen pipeline; produce the generated schema.

- [ ] T001 Add `kysely` (dependencies) and `kysely-codegen` (devDependencies) to
  `backend/package.json`; run `pnpm install` from repo root (workspace lockfile). Do NOT
  remove `pg`/`@types/pg` (kept for the pool + migration runner).
- [ ] T002 Create `backend/scripts/generate-kysely-types.sh` mirroring
  `backend/scripts/dump-schema.sh`: spin up / target a scratch DB, apply all
  `src/db/migrations/*.sql`, run `kysely-codegen` with type overrides
  (`vector`/`vector(1536)`→`string`, `tsvector`→`string`, `jsonb`→`unknown`) to
  `src/shared/infra/kysely/schema.ts`.
- [ ] T003 Add `db:types` and `db:types:check` scripts to `backend/package.json`
  (mirroring `db:schema` / `db:schema:check`); `db:types:check` fails on drift.
- [ ] T004 Run `pnpm --dir backend run db:types`; commit the generated
  `backend/src/shared/infra/kysely/schema.ts` (generated-only; add a do-not-edit header).
- [ ] T005 Wire `db:types:check` into the local CI script (`pnpm run ci:local`) and the
  backend `test:contract`/build path so drift is caught.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The Kysely instance, executor type, SQL-fragment helpers, composition wiring,
and a harness proving Kysely + raw SQL coexist on one pool/transaction.

**⚠️ CRITICAL**: No repository migration (US1–US3) can begin until this phase is complete.

- [ ] T006 [P] Create `backend/src/shared/infra/kysely/types.ts` exporting
  `type Db = Kysely<DB> | Transaction<DB>` (the injected executor port) and re-exporting
  `DB` from `schema.ts`.
- [ ] T007 Create `backend/src/shared/infra/kysely/kyselyDatabase.ts`:
  `createKyselyDatabase(pool: pg.Pool): Kysely<DB>` using `PostgresDialect` over the
  EXISTING pool from `Database`. Add a `close`/lifecycle note (pool owned by `Database`).
- [ ] T008 [P] Write an integration test
  `backend/tests/integration/kysely-foundation.integration.test.ts`: a Kysely write and a
  raw `Database.query` read see the same row inside one `db.transaction()`, and rollback
  works across both. (Proves D1/D4.) MUST be green before T009+.
- [ ] T009 Create `backend/src/shared/infra/kysely/sqlHelpers.ts` with typed `sql`
  fragments and UNIT/INTEGRATION tests for each:
  - `vectorDistance(col, param)` (`<=>`), `castVector(value, dims?)` (`::vector(1536)`/`::vector`),
    `vectorDims(col)`.
  - `tsMatch(col, query)` (`@@`), `tsRankCd(...)`, `plainToTsQuery`/`phraseToTsQuery`,
    `toTsVector('simple', …)`.
  - `jsonbContains` (`@>`), `jsonbPathText` (`#>>`), `jsonbKeyText` (`->>`).
  - `anyOf(values, pgType)` (`= ANY($::type[])`), array-literal helper.
  - `forUpdateSkipLocked(...)` (incl. `OF <alias>`), `setLocal(name, value)`.
  Each helper has a focused test asserting the emitted SQL + a round-trip against real
  Postgres. This file is the ONLY application home for raw fragments.
- [ ] T010 Update `backend/src/app/server/dependencyBuilders.ts` (and
  `backend/src/app/composition/` if app-wide lifecycle applies) to construct the
  `Kysely<DB>` instance from the existing pool and inject `Db` into repositories. Keep
  `Database` available for the migration runner and not-yet-migrated repos (mixed state).
- [ ] T011 [P] Add a test-support helper in `backend/tests/support/` to obtain a
  `Kysely<DB>` bound to the test database (parallel to the existing `Database` fixture).

**Checkpoint**: Foundation ready — repositories can now be migrated one at a time.

---

## Phase 3: User Story 1 — Reference repository (Priority: P1) 🎯 MVP

**Goal**: One simple repository fully migrated end-to-end, proving the pattern + types +
transactions + tests, plus the worked example others copy.

**Independent Test**: `sessionRepository` tests pass unchanged; a deliberate bad-column
query fails `tsc`.

### Tests for User Story 1

- [ ] T012 [US1] Ensure a GREEN integration safety net for `sessionRepository` in
  `backend/tests/integration/` (write a characterization test against the current raw SQL
  if none exists). Confirm it passes BEFORE T013.
- [ ] T013 [P] [US1] Add a negative-compile fixture
  (`backend/tests/contract/kysely-typecheck.test-d.ts` or a `tsc --noEmit` guard) proving
  a query against a non-existent column/table fails type-checking (SC-003).

### Implementation for User Story 1

- [ ] T014 [US1] Migrate `backend/src/db/repositories/sessionRepository.ts` internals to
  Kysely; port + `SessionRecord` unchanged; accept `Db` via constructor. Tests from T012
  stay green; `tsc --noEmit` clean.
- [ ] T015 [US1] Document the worked example in
  `backend/src/db/repositories/README.md` (Kysely version of the "adding a new entity"
  walkthrough) — this is the template later tasks reference. (Docs are a deliverable.)

**Checkpoint**: Pattern proven; US2/US3 can proceed in parallel.

---

## Phase 4: User Story 2 — CRUD repositories (Priority: P2)

**Goal**: Migrate the ~28 straightforward repositories. Each: ensure green safety net →
swap to Kysely → tests green → `tsc` clean → commit. All `[P]` relative to each other
(different files), but each depends on Phase 2.

**Independent Test**: Each repository's existing tests pass unchanged after its swap.

> For EACH task below, the definition of done is: port unchanged, `*Record` identical,
> existing/characterization tests green, no raw SQL string remains, `tsc --noEmit` clean.

- [ ] T016 [P] [US2] `abuseControlRepository.ts`
- [ ] T017 [P] [US2] `accessGrantRepository.ts`
- [ ] T018 [P] [US2] `accountInvitationRepository.ts`
- [ ] T019 [P] [US2] `accountMembershipRepository.ts`
- [ ] T020 [P] [US2] `accountRepository.ts`
- [ ] T021 [P] [US2] `auditEventRepository.ts` (dynamic filter — use Kysely conditional `.where()`)
- [ ] T022 [P] [US2] `bootstrapGreetingCacheRepository.ts` (`ON CONFLICT` upsert)
- [ ] T023 [P] [US2] `clarificationStateRepository.ts`
- [ ] T024 [P] [US2] `conversationOwnershipRepository.ts`
- [ ] T025 [P] [US2] `customerEmailConnectionRepository.ts`
- [ ] T026 [P] [US2] `documentSourceRepository.ts`
- [ ] T027 [P] [US2] `emailSkillActivityRepository.ts`
- [ ] T028 [P] [US2] `emailSkillDefinitionRepository.ts`
- [ ] T029 [P] [US2] `emailVerificationTokenRepository.ts`
- [ ] T030 [P] [US2] `externalSkillDefinitionRepository.ts`
- [ ] T031 [P] [US2] `historyItemsRepository.ts`
- [ ] T032 [P] [US2] `mcpConnectionRepository.ts` (JSONB settings column)
- [ ] T033 [P] [US2] `oauthConnectionRepository.ts` (dynamic filter)
- [ ] T034 [P] [US2] `passwordResetTokenRepository.ts`
- [ ] T035 [P] [US2] `pendingDecisionRepository.ts`
- [ ] T036 [P] [US2] `retrievalSettingsRepository.ts` (`ON CONFLICT DO NOTHING`)
- [ ] T037 [P] [US2] `routineStateRepository.ts`
- [ ] T038 [P] [US2] `userRepository.ts`
- [ ] T039 [P] [US2] `webhookDestinationRepository.ts`
- [ ] T040 [P] [US2] `webhookSkillDefinitionRepository.ts`
- [ ] T041 [P] [US2] `workspaceGrantRepository.ts`
- [ ] T042 [P] [US2] `workspaceProviderCredentialsRepository.ts`
- [ ] T043 [P] [US2] `workspaceTokenRepository.ts` (`ON CONFLICT DO UPDATE`)

**Checkpoint**: The bulk of the surface is on Kysely; complex repos remain.

---

## Phase 5: User Story 3 — Complex repositories & module SQL (Priority: P3)

**Goal**: Migrate the high-complexity persistence and the module-level SQL. Each needs a
strong real-Postgres safety net (parity fixtures for retrieval). Use `sqlHelpers` for all
Postgres-specific fragments.

**Independent Test**: Per area — integration tests + parity assertions pass; for retrieval,
identical chunk IDs/ordering/scores vs raw-SQL baseline.

### Cursor-pagination repositories

- [ ] T044 [US3] Characterization test capturing exact pages/ordering for
  `conversationRepository.ts` and `messageRepository.ts` (keyset/tuple comparison),
  GREEN on raw SQL.
- [ ] T045 [US3] Migrate `conversationRepository.ts` (cursor tuple comparison via
  `sqlHelpers`/`eb.or`; preserve `decodeCursorWithKeys` usage and boundaries).
- [ ] T046 [US3] Migrate `messageRepository.ts` (sorting/filtering/pagination preserved).

### Aggregate / LATERAL / array repositories

- [ ] T047 [US3] Characterization tests for `documentRepository.ts` (upsert w/ partial-index
  conflict target, `RETURNING`, `ARRAY_AGG … FILTER`, `COUNT(*) FILTER`, keyset pagination,
  JSONB `->>`), GREEN on raw SQL.
- [ ] T048 [US3] Migrate `documentRepository.ts` + `documentRowMapper.ts` (use
  `jsonObjectFrom`/`jsonArrayFrom` or `sqlHelpers`; preserve byte-count coercion).
- [ ] T049 [US3] Characterization test for `routineDefinitionRepository.ts` (6× `LATERAL` +
  `json_agg(json_build_object(...) ORDER BY …)`), GREEN on raw SQL.
- [ ] T050 [US3] Migrate `routineDefinitionRepository.ts` (use `jsonArrayFrom`/`jsonObjectFrom`
  from `kysely/helpers/postgres`; preserve nested ordering).
- [ ] T051 [US3] Characterization test for `agentRepository.ts` (`ARRAY_AGG`, `unnest`,
  nested directive JSON, `ARRAY[]::text[]` defaults), GREEN on raw SQL.
- [ ] T052 [US3] Migrate `agentRepository.ts`.
- [ ] T053 [US3] Migrate `workspaceRepository.ts` (workspace-level aggregations).

### Worker job-claim repositories (`FOR UPDATE SKIP LOCKED`)

- [ ] T054 [US3] Concurrency characterization test asserting exactly-once claim for
  `actionRequestRepository.ts`, `documentProcessingJobRepository.ts`,
  `websiteCrawlJobRepository.ts` (parallel claim attempts), GREEN on raw SQL.
- [ ] T055 [US3] Migrate `actionRequestRepository.ts` (`FOR UPDATE SKIP LOCKED` +
  `ON CONFLICT DO NOTHING` idempotency via `sqlHelpers`).
- [ ] T056 [US3] Migrate `documentProcessingJobRepository.ts` (`FOR UPDATE OF d SKIP LOCKED`).
- [ ] T057 [US3] Migrate `websiteCrawlJobRepository.ts` (job-claim).
- [ ] T058 [US3] Migrate `ingestionSettingsRepository.ts` (`FOR UPDATE` + `ON CONFLICT`).

### Retrieval infrastructure (pgvector + full-text) — highest risk

- [ ] T059 [US3] Build a retrieval parity fixture
  (`backend/tests/integration/retrieval-parity.integration.test.ts`): fixed corpus + query
  set, capturing chunk IDs, ordering, and scores from the raw-SQL implementation as the
  baseline (SC-004). GREEN on raw SQL.
- [ ] T060 [US3] Migrate `modules/retrieval/infra/vectorSearch.ts` (CTE `MATERIALIZED`,
  `<=>` distance, bounded/unbounded column selection, `vector_dims`, `SET LOCAL
  hnsw.iterative_scan` inside a Kysely transaction — all via `sqlHelpers`). Verify
  `EXPLAIN` still uses the hnsw/ivfflat index.
- [ ] T061 [US3] Migrate `modules/retrieval/infra/lexicalSearch.ts` (`to_tsvector('simple')`,
  `plainto_tsquery`/`phraseto_tsquery`, `@@`, `ts_rank_cd` via `sqlHelpers`; remove the
  token-substitution assembly in favor of Kysely conditionals). Verify GIN index usage.
- [ ] T062 [US3] Migrate `modules/retrieval/infra/chunkVectorStorage.ts` (bulk insert with
  `::vector` casts + serialized vector literal; preserve bounded/unbounded split).
- [ ] T063 [US3] Migrate `modules/retrieval/infra/pgChunkFilter.ts` (JSONB `@>` +
  `ANY($::uuid[])` source filter via `sqlHelpers`; this is a shared fragment used by
  vector + lexical search — migrate alongside T060/T061).
- [ ] T064 [US3] Migrate `modules/documents/infra/chunkRepository.ts`.

### Dynamic query builders (reporting / quality)

- [ ] T065 [US3] Characterization tests for every filter combination of
  `modules/reporting/usageTrendsQuery.ts` + `service.ts` (`date_trunc` bucketing,
  `GROUP BY`, `SUM`, conditional joins), GREEN on raw SQL.
- [ ] T066 [US3] Migrate `modules/reporting/usageTrendsQuery.ts` + `service.ts` to Kysely
  conditional builders (replace `params.push()` string assembly).
- [ ] T067 [US3] Characterization tests for `modules/quality/service.ts` (15+ conditional
  filters, conditional `LATERAL` join to `audit_events`, `#>`/`#>>` paths,
  `unnest($::text[], $::text[])`, `EXISTS`/`NOT EXISTS` feedback filters), GREEN on raw SQL.
- [ ] T068 [US3] Migrate `modules/quality/service.ts` to Kysely conditional builders +
  `sqlHelpers`.

### Remaining module SQL

- [ ] T069 [P] [US3] Migrate `shared/infra/usage/durableUsageEventRecorder.ts`
  (`ON CONFLICT DO UPDATE` token rollups + idempotency dedupe).
- [ ] T070 [P] [US3] Migrate `modules/eval/services/evalRepository.ts`.
- [ ] T071 [US3] Sweep for any remaining `.query(`/`databaseExecutorFromClient`/
  `withTransaction` call sites in application code (`grep`); migrate stragglers or record
  them as allowlisted exceptions with a documented reason (SC-007).

**Checkpoint**: All application persistence runs on Kysely; only the runner + `sqlHelpers`
contain raw SQL.

---

## Phase 6: User Story 4 — Lock in the convention (Priority: P3)

**Goal**: Prevent regression to raw SQL; finalize docs.

- [ ] T072 [US4] Extend `backend/dependency-cruiser.config.cjs` (or add a focused lint
  rule) to forbid raw SQL query strings / `.query(`,`.queryOne(`,`.queryOptional(`,
  `.execute(` with SQL literals and inline `SELECT|INSERT|UPDATE|DELETE` strings in
  `src/db/repositories/**` and `src/modules/**/infra/**`, allowlisting
  `src/db/runMigrations.ts` and `src/shared/infra/kysely/sqlHelpers.ts`. Add a failing
  fixture + assertion that the rule trips.
- [ ] T073 [US4] Run `pnpm --dir backend run lint:boundaries`; resolve any violation to
  zero (SC-002).
- [ ] T074 [US4] Narrow `backend/src/shared/infra/database.ts`: keep pool lifecycle +
  the raw path for the migration runner; mark/relocate `query*`/`withTransaction`/
  `databaseExecutorFromClient` as runner-only (do NOT delete while the runner needs them).
- [ ] T075 [US4] Update docs (Docs are a deliverable):
  `backend/src/db/repositories/README.md` (Kysely is canonical),
  `docs/architecture/code-map.md` (data-access entry points), and any local brief that
  references raw-SQL repositories.

---

## Phase 7: Polish & Cross-Cutting

- [ ] T076 Run the full backend suite green: `pnpm --dir backend test` (unit + integration
  + contract) and `pnpm --dir backend exec tsc -p tsconfig.json --noEmit` (SC-001).
- [ ] T077 [P] Performance check: capture p95 for retrieval search, conversation listing,
  document listing; confirm within 5% of the raw-SQL baseline (SC-005). Record numbers in
  the PR body.
- [ ] T078 [P] Convert remaining `Database`-mock unit tests that only assert SQL strings
  into behavior-level integration tests (or delete if redundant with integration coverage).
- [ ] T079 Run `pnpm run ci:local -- origin/main` (with a fresh pgvector test DB) and
  include the result in the PR body.
- [ ] T080 Final `db:types:check` + boundary-lint + contract check; confirm no OpenAPI/SDK/
  MCP/worker contract changed (`contracts/README.md`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: depends on Setup — BLOCKS all repository migration.
- **US1 (Phase 3)**: depends on Foundational; proves the pattern (MVP).
- **US2 (Phase 4)**: depends on Foundational; best after US1's worked example exists.
- **US3 (Phase 5)**: depends on Foundational; can run in parallel with US2 (different
  files). Within US3, each "characterization → migrate" pair is ordered (test first).
- **US4 (Phase 6)**: depends on US2 + US3 being complete (the guard must not fail on
  not-yet-migrated files).
- **Polish (Phase 7)**: last.

### Within Each Repository Task

1. Green integration/characterization safety net on raw SQL FIRST (TDD anchor).
2. Swap internals to Kysely; port + `*Record` unchanged.
3. Use `sqlHelpers` for Postgres-specific fragments — no inline `sql` in repositories.
4. Tests green + `tsc --noEmit` clean + no raw SQL string remains.
5. Commit per repository (`refactor(db): migrate <repo> to Kysely`).

### Parallel Opportunities

- All Phase 4 (US2) tasks are `[P]` — different files, independent. A team can split them.
- US2 and US3 can proceed concurrently after Phase 2.
- T069/T070 are `[P]`. Retrieval (T060–T063) is internally coupled (shared `pgChunkFilter`)
  — migrate together.

---

## Implementation Strategy

### MVP First

1. Phase 1 (Setup) → Phase 2 (Foundational) → Phase 3 (US1 reference repo).
2. STOP and validate: `sessionRepository` tests green, negative compile test fails to
   compile, `db:types:check` green. This is a demonstrable MVP of the new pattern.

### Incremental Delivery

3. Phase 4 (US2) repositories, shipped in batches (each repo is a safe, independent PR/commit).
4. Phase 5 (US3) complex repos + module SQL, retrieval last with parity fixtures.
5. Phase 6 (US4) enforcement + docs once zero raw-SQL callers remain.
6. Phase 7 polish + full CI.

### Notes

- [P] = different files, no dependencies.
- Each repository is independently completable and testable behind its unchanged port.
- Verify the safety-net test is green on raw SQL BEFORE swapping (the swap must not change
  behavior).
- Keep the migration runner and `sqlHelpers` as the only raw-SQL homes.
- Do NOT change query behavior, ordering, or pagination "while in there" — behavior
  changes are separate work.
