# Implementation Plan: Migrate Backend Data Access from Raw SQL to Kysely

**Branch**: `093-raw-sql-to-kysely` | **Date**: 2026-06-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/093-raw-sql-to-kysely/spec.md`

## Summary

Replace hand-written SQL strings in the backend persistence layer with the Kysely query
builder, type-checked against a generated database schema, **without changing any
repository port, domain record, runtime behavior, or cross-service contract**. Build the
Kysely instance on the existing `pg.Pool`; generate `DB` types from the migrations with
`kysely-codegen` (committed, drift-checked); centralize Postgres-specific SQL (pgvector,
full-text search, JSONB, row locking, session settings) in one typed helpers module;
migrate repositories incrementally behind unchanged ports — simple CRUD first, complex/
retrieval last; then enforce "no raw SQL in application code" via the boundary linter and
update the docs. Schema migrations stay raw `.sql` and are out of scope.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js 24, ESM
**Primary Dependencies**: `kysely` (runtime), `kysely-codegen` (dev), existing `pg` /
`@types/pg` (kept for pool + migration runner)
**Storage**: PostgreSQL 16 + `pgvector` (unchanged schema)
**Testing**: Vitest (unit + integration against real Postgres via `tests/support`),
Supertest, contract tests; characterization tests added where coverage is thin
**Target Platform**: Linux server (backend service + document worker)
**Project Type**: Web (backend + frontend); this feature is **backend-only**
**Performance Goals**: No regression — representative query p95 within 5% of raw-SQL
baseline (SC-005); retrieval result parity exact (SC-004)
**Constraints**: Zero behavior change; zero contract change; generated schema must stay
in sync with migrations; pgvector/FTS preserved; one connection pool / one transaction
context throughout the mixed-state rollout
**Scale/Scope**: ~40 repositories (~314 query sites) + ~8 module-level SQL files; ~99
raw `.sql` migrations remain untouched

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- ✅ Spec exists and is approved before implementation (this plan does not authorize
  coding; spec must be approved first).
- ✅ Backend TDD: existing tests are the behavioral spec; characterization tests written
  and green on raw SQL before each swap; same tests green after.
- ✅ Frontend Playwright: N/A — no frontend change.
- ✅ Stack unchanged: Node.js backend, PostgreSQL + pgvector.
- ✅ LLM provider: unaffected.
- ✅ Secrets: no new secrets; `.env`/`.env.example` unchanged (codegen uses the existing
  dev/test database URL).
- ✅ Customer data handling/auditability: unchanged access paths, same pool/credentials.
- ✅ Module boundaries explicit: transport/orchestration/domain untouched; only
  persistence adapters change internals; domain still depends on ports.
- ✅ Responsibility-limited files identified: generated `schema.ts` is generated-only;
  `sqlHelpers.ts` is the sole raw-fragment home; `*Record` must not import Kysely types.
- ✅ Structure clear / files not oversized for this work: largest repos
  (`documentRepository`, `routineDefinitionRepository`, `agentRepository`) are migrated
  in place (internal swap), not enlarged; no new god object introduced.
- ✅ App-wide infrastructure wiring: a new replaceable adapter (the Kysely instance /
  `Db` executor) is introduced — wired in `backend/src/app/server/dependencyBuilders.ts`
  / `backend/src/app/composition/` per the composition decision; domain rules stay in
  modules.
- ✅ HTTP contracts: none change → `openapi/document.ts` and generated `openapi.*`
  untouched.
- ✅ Cross-service contracts (SDK/MCP/connector/worker/AMQP): none change → message-queue
  impact review = "no change" (see `contracts/README.md`).
- ✅ Docs: repositories README + architecture code-map updated in the same feature (US4).

**Result: PASS.** No violations; Complexity Tracking left empty.

## Project Structure

### Documentation (this feature)

```text
specs/093-raw-sql-to-kysely/
├── plan.md              # This file
├── research.md          # Phase 0: inventory + decisions
├── data-model.md        # Phase 1: type seams + invariants (no schema change)
├── quickstart.md        # Phase 1: per-repository migration walkthrough
├── contracts/README.md  # Phase 1: cross-service contract impact (none)
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 (/speckit.tasks output)
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── shared/infra/
│   │   ├── database.ts                 # KEEP: pool lifecycle + migration runner raw path
│   │   └── kysely/                     # NEW seam
│   │       ├── schema.ts               # GENERATED (kysely-codegen); do not edit
│   │       ├── kyselyDatabase.ts       # NEW: Kysely<DB> over the existing pg.Pool
│   │       ├── sqlHelpers.ts           # NEW: pgvector/FTS/JSONB/locking/SET LOCAL fragments
│   │       └── types.ts                # NEW: `Db = Kysely<DB> | Transaction<DB>`
│   ├── db/
│   │   ├── repositories/*.ts           # MIGRATE internals (ports unchanged)
│   │   ├── migrations/*.sql            # UNCHANGED (out of scope)
│   │   └── runMigrations.ts            # UNCHANGED (allowed raw-SQL exception)
│   ├── modules/retrieval/infra/*.ts    # MIGRATE: vector + lexical search via sqlHelpers
│   ├── modules/reporting/*.ts          # MIGRATE: dynamic trend builders → Kysely conditionals
│   ├── modules/quality/service.ts      # MIGRATE: dynamic triage filters → Kysely conditionals
│   └── app/server/dependencyBuilders.ts# WIRE: inject Kysely Db into repositories
├── scripts/
│   ├── dump-schema.sh                  # existing pattern to mirror
│   └── generate-kysely-types.sh        # NEW: apply migrations → kysely-codegen → schema.ts
├── dependency-cruiser.config.cjs       # EXTEND: forbid raw SQL outside runner + sqlHelpers
└── tests/{unit,integration,contract}/  # characterization + parity tests
```

**Structure Decision**: Web app, backend-only change. New persistence infrastructure
lives under `backend/src/shared/infra/kysely/`. Persistence adapters in
`backend/src/db/repositories/` and `backend/src/modules/*/infra/` change internals only.
Orchestration (`modules/*/services`), transport (`app/http`), and domain records are
untouched. Composition wiring (the Kysely instance as a replaceable adapter) is owned by
`backend/src/app/server/dependencyBuilders.ts` / `backend/src/app/composition/`.

## Module Ownership & Seams

- **Transport Layer**: `backend/src/app/http/*` — unchanged.
- **Orchestration Layer**: `backend/src/modules/*/services/*` — unchanged; still call
  repository ports. Services that own a transaction boundary switch from
  `withTransaction(cb)` to `db.transaction().execute(trx => …)` and thread `trx`.
- **Domain Layer**: `backend/src/modules/*` domain logic + `*RepositoryPort` interfaces —
  unchanged. Domain never imports Kysely or `schema.ts`.
- **Persistence/Integration Layer**: `backend/src/db/repositories/*` and
  `backend/src/modules/*/infra/*` — internals migrate to Kysely. `*RowMapper` modules
  keep responsibility (row→record + coercion).
- **Application Composition**: YES — `backend/src/app/server/dependencyBuilders.ts` (and
  `backend/src/app/composition/` if app-wide lifecycle is involved) wires the new
  `Kysely<DB>` instance as the replaceable persistence adapter injected into repositories.
  Pool lifecycle/shutdown remains a single owner.
- **Files Kept Small**:
  - `schema.ts` — generated only, never hand-edited.
  - `sqlHelpers.ts` — the *only* raw-fragment home; do not let business logic leak in.
  - `*Record` types / domain modules — must not absorb Kysely types.
- **Planned Extractions**:
  - `shared/infra/kysely/{kyselyDatabase,sqlHelpers,types}.ts` (new).
  - `scripts/generate-kysely-types.sh` + `db:types` / `db:types:check` package scripts.
  - Boundary-lint rule for raw-SQL containment.
- **Required Refactor Stories**: None blocking — the migration is an in-place internal
  swap per repository; no pre-refactor of oversized files is required because no file
  grows in responsibility.

## Phasing (maps to spec user stories)

- **Phase 1 — Setup**: add deps; codegen pipeline + `db:types`/`db:types:check`; generate
  `schema.ts`.
- **Phase 2 — Foundational (blocks all stories)**: `kyselyDatabase.ts`, `types.ts`,
  `sqlHelpers.ts` (with thin validated fragments for vector distance/cast/dims, FTS
  predicate/rank, JSONB ops, `forUpdateSkipLocked`, `setLocal`), composition wiring, and
  the integration-test harness confirming Kysely + raw SQL share a pool/transaction.
- **Phase 3 — US1 (P1, MVP)**: migrate one simple reference repository end-to-end +
  negative compile test; write the worked example.
- **Phase 4 — US2 (P2)**: migrate the ~30 CRUD repositories, each independently, tests
  green.
- **Phase 5 — US3 (P3)**: migrate complex repos (`LATERAL`/`json_agg`, job-claim) and
  module SQL (reporting, quality, retrieval vector + lexical), with parity fixtures.
- **Phase 6 — US4 (P3)**: enable the boundary guard; update docs; optionally narrow the
  `Database` raw API.

## Complexity Tracking

> No Constitution Check violations. Section intentionally empty.
