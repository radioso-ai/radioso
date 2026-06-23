# Phase 0 Research: Raw SQL → Kysely Migration

**Feature**: 093-raw-sql-to-kysely
**Date**: 2026-06-21

This document records the current-state inventory and the technical decisions that
shape the plan. It is the evidence base for `plan.md`.

## Current-state inventory

### Data-access abstraction

- `backend/src/shared/infra/database.ts` owns:
  - `Database` class wrapping a `pg.Pool`, exposing `query` / `queryOptional` /
    `queryOne` / `execute` (all take a SQL string + params) and `withTransaction(cb)`.
  - `DatabaseExecutor` interface (the same four read/write methods) — the type
    repositories actually depend on inside transactions.
  - `databaseExecutorFromClient(client)` — wraps a `PoolClient` so a repository method
    can run on a transaction-bound connection.
- Repositories receive a `Database` via **constructor injection**; composition wiring
  lives in `backend/src/app/server/dependencyBuilders.ts`.
- The ports-and-adapters contract is documented in
  `backend/src/db/repositories/README.md`: domain modules depend on a
  `*RepositoryPort` interface; the adapter owns the SQL; a `*RowMapper` converts
  snake_case rows to camelCase domain records; `db/migrations/*.sql` is the system of
  record.

### Surface to migrate

- **~40 repositories** in `backend/src/db/repositories/`, ~314 query call sites total.
  Largest/most complex: `documentRepository.ts` (~835 LOC, upserts + pagination +
  JSONB), `routineDefinitionRepository.ts` (~620 LOC, 6× `LATERAL` + `json_agg`),
  `agentRepository.ts` (~913 LOC, `ARRAY_AGG`/`unnest`), `websiteCrawlJobRepository.ts`
  and `documentProcessingJobRepository.ts` (`FOR UPDATE [OF ..] SKIP LOCKED`).
- **Module-level SQL** outside repositories:
  - `modules/retrieval/infra/vectorSearch.ts` — pgvector CTE, `<=>` distance,
    `::vector(1536)`/`::vector`, `vector_dims()`, `SET LOCAL hnsw.iterative_scan`.
  - `modules/retrieval/infra/lexicalSearch.ts` — `to_tsvector('simple', …)`,
    `plainto_tsquery`/`phraseto_tsquery`, `@@`, `ts_rank_cd`, token-substitution query
    assembly.
  - `modules/retrieval/infra/chunkVectorStorage.ts` — bulk vector insert with `::vector`
    casts and a serialized `[a,b,c]` vector literal.
  - `modules/retrieval/infra/pgChunkFilter.ts` — JSONB `@>` containment + `ANY($n::uuid[])`.
  - `modules/reporting/usageTrendsQuery.ts` + `service.ts` — dynamic `params.push()` SQL
    builders, `date_trunc` bucketing, `GROUP BY`, `SUM`.
  - `modules/quality/service.ts` — 15+ conditional filter blocks, conditional `LATERAL`
    join to `audit_events`, `#>`/`#>>` JSONB path extraction, `unnest($::text[], $::text[])`.
  - `shared/infra/usage/durableUsageEventRecorder.ts` — `ON CONFLICT … DO UPDATE` token
    rollups + idempotency dedupe.

### Postgres features that must survive (the hard set)

| Feature | Example site | Kysely strategy |
|---------|--------------|-----------------|
| pgvector distance `<=>`, `::vector(n)` cast, `vector_dims()` | `vectorSearch.ts` | `sql` fragments in the typed helpers module |
| `SET LOCAL` session settings on the query connection | `vectorSearch.ts`, `runMigrations.ts` | run inside a Kysely transaction; `sql.raw` on the trx connection |
| Full-text `to_tsvector`/`tsquery`/`@@`/`ts_rank_cd` | `lexicalSearch.ts` | `sql` fragments in the typed helpers module |
| `ON CONFLICT … DO UPDATE/NOTHING` incl. partial index target | `documentRepository.ts`, `actionRequestRepository.ts` | `onConflict((oc) => oc.columns([...]).where(...).doUpdateSet(...))` |
| `RETURNING` | throughout | `.returning([...])` / `.returningAll()` |
| `FOR UPDATE [OF ..] SKIP LOCKED` | job-claim repos | `.forUpdate().skipLocked()` (`.of(...)` via `sql` if needed) |
| `LATERAL` + `json_agg(json_build_object(...))` | `routineDefinitionRepository.ts` | `jsonArrayFrom`/`jsonObjectFrom` from `kysely/helpers/postgres`, or `sql` |
| `ARRAY_AGG`, `unnest`, `ANY($::type[])`, array literals | `agentRepository.ts`, `quality/service.ts` | `sql` fragments; `eb(col, '=', sql\`any(${...})\`)` |
| JSONB `->`/`->>`/`#>`/`#>>`/`@>` | `quality/service.ts`, `pgChunkFilter.ts` | `sql` fragments in helpers; Kysely JSON helpers where they fit |
| Dynamic conditional WHERE/JOIN | `quality/service.ts`, `usageTrendsQuery.ts` | Kysely is *better* here — conditional `.where()` chaining, no string concat |
| Keyset/cursor tuple comparison | `documentRepository.ts` | `eb.or([...])` / `(col1, col2) < (a, b)` via `sql` |
| `COUNT(*) FILTER (WHERE …)`, `date_trunc`, casts | reporting/quality/document | `fn.count().filterWhere(...)`, `sql` casts |

### Migration runner (out of scope)

- `backend/src/db/runMigrations.ts` runs raw `.sql` files from `backend/src/db/migrations/`
  (99 files) inside a transaction, recording applied files in `schema_migrations`, and
  disables `lock_timeout`/`statement_timeout` per migration. `backend/src/db/schema.sql`
  is a generated snapshot (`pnpm --dir backend run db:schema`, checked by
  `db:schema:check`). **Decision: migrations stay raw SQL.** The runner keeps a raw
  execution path; it is an allowed raw-SQL exception.

### Test landscape

- Unit tests (`backend/tests/unit/*`) mostly **mock** the `Database` interface — these
  will need updating because the mock surface changes from "string in, rows out" to a
  Kysely query builder. Prefer migrating thin-mock unit tests toward integration tests
  against real Postgres where they actually exercise SQL.
- Integration tests (`backend/tests/integration/*`) run against a **real Postgres**
  (pgvector) via `tests/support/databaseMigrations.ts` + `testApp.ts`. These are the
  behavior-preservation safety net and should pass unchanged.
- Contract tests (`backend/tests/contract/*`) assert API/SDK/MCP contracts — these must
  not change (this migration touches no contract).

## Key decisions

### D1 — Build Kysely on the existing `pg.Pool` (one pool, one transaction context)

Construct `Kysely<DB>` with `PostgresDialect` over the **same** `pg.Pool` that
`Database` already owns. This lets raw-SQL repositories and Kysely repositories
coexist during the rollout and participate in the same transactions. Rejected:
a second pool (doubles connections, splits transaction context).

### D2 — Generate the schema types with `kysely-codegen` from a live, migrated DB

Add `pnpm --dir backend run db:types` that applies migrations to a scratch database and
runs `kysely-codegen` → `backend/src/shared/infra/kysely/schema.ts` (committed,
generated-only). Add `db:types:check` mirroring `db:schema:check` for CI drift
detection. Rationale: the migrations are already the source of truth and there is an
existing dump-from-live-DB pattern (`dump-schema.sh`); mirror it. Custom column types
(pgvector `vector`, `tsvector`) are mapped via a codegen type-overrides config to
`string` (matching today's serialized handling). Rejected: hand-writing the `DB`
interface (drifts immediately); Kysely's own migrations (we keep `.sql`).

### D3 — Centralize Postgres-specific SQL in one typed helpers module

`backend/src/shared/infra/kysely/sqlHelpers.ts` (name TBD) owns vector distance,
vector casts, `vector_dims`, FTS predicates/ranking, JSONB path/containment operators,
row-lock clauses, and `SET LOCAL` helpers as typed, reusable `sql` fragments. This is
the **only** application location (besides the migration runner) allowed to contain raw
SQL after the migration, which is what the FR-014 guard enforces. Rationale: keeps the
escape hatch auditable and testable; prevents `sql` tags sprawling across 40 files.

### D4 — Transaction propagation via `Kysely<DB> | Transaction<DB>`

Replace `withTransaction(client => …)` + `databaseExecutorFromClient` with
`db.transaction().execute(async (trx) => …)`. Repositories that must participate in a
caller's transaction accept an executor typed as `Kysely<DB> | Transaction<DB>` (both
expose the same query-builder API). Where a service coordinates multiple repositories
in one transaction, it threads `trx` to each. Rationale: native Kysely transactions,
no bespoke executor adapter. A small `Db = Kysely<DB> | Transaction<DB>` alias becomes
the injected port type.

### D5 — Migrate incrementally behind unchanged ports; characterize where coverage is thin

Each repository keeps its `*RepositoryPort` and `*Record` types. Swap internals one
repo at a time. For repos whose only tests are thin `Database` mocks (which assert SQL
strings rather than behavior), write integration-level characterization tests against
real Postgres **first** (green on raw SQL), then swap to Kysely and keep them green.
Rationale: behavior preservation is the whole point; mock-string assertions don't prove
it and will break mechanically on the rewrite.

### D6 — Enforce the convention after the bulk is done

Extend `backend/dependency-cruiser.config.cjs` (or add a focused lint rule) to forbid
raw query strings (`.query(`, `.queryOne(`, `.execute(` with string literals, inline
`SELECT`/`INSERT`/`UPDATE`/`DELETE` strings) in `db/repositories` and `modules/*/infra`,
allowlisting the migration runner and the typed helpers module. Rationale: without a
guard, drift is inevitable (D6 of the constitution's "files kept small" spirit).

### D7 — Phasing by risk

Order: foundation + 1 reference repo (P1) → ~30 CRUD repos (P2) → complex/`LATERAL`/
job-claim/reporting/quality/retrieval (P3) → enforcement + docs (P3). Rationale:
retire risk progressively; the foundation must prove pgvector/FTS/transactions before
the complex repos rely on it, so a thin vertical of each hard feature is validated
early via the helpers module even though the complex repos migrate last.

## Open questions (resolved with defaults)

- **Drop `Database.query*` raw methods entirely?** No — keep them for the migration
  runner and any allowlisted exception, but make them lint-forbidden in repositories/
  modules. Removing them outright is a follow-up once zero callers remain.
- **`kysely-codegen` vs hand-rolled introspection?** Use `kysely-codegen`; it is the
  de-facto tool and matches the "generate from live migrated DB" pattern already used
  for `schema.sql`.
- **Unit-mock tests:** convert behavior-meaningful ones to integration tests; delete
  pure SQL-string assertions that no longer make sense.
