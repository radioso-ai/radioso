# Quickstart: Migrating a Repository to Kysely

**Feature**: 093-raw-sql-to-kysely
**Date**: 2026-06-21

This is the step-by-step an engineer follows to migrate one repository. It is also the
acceptance walkthrough for the foundation (US1).

## One-time foundation (US1, done once)

1. Add dependencies in `backend/`: `kysely`, plus dev `kysely-codegen`.
2. Generate the schema types:
   ```bash
   pnpm --dir backend run db:types        # applies migrations to a scratch DB, runs codegen
   ```
   Produces `backend/src/shared/infra/kysely/schema.ts` (committed, generated-only).
3. Confirm the drift guard:
   ```bash
   pnpm --dir backend run db:types:check   # fails if schema.ts is stale vs migrations
   ```
4. The Kysely instance is built on the existing pool in
   `backend/src/shared/infra/kysely/kyselyDatabase.ts` and wired in
   `backend/src/app/server/dependencyBuilders.ts`.
5. Postgres-specific fragments live in `backend/src/shared/infra/kysely/sqlHelpers.ts`.

## Per-repository loop

1. **Pick a repository** and read its `*RepositoryPort`, `*Row`, `*Record`, and mapper.
2. **Guarantee a safety net.** Run its tests:
   ```bash
   cd backend && pnpm exec vitest run tests/integration/<repo>.integration.test.ts
   ```
   If the only coverage is a `Database`-mock unit test asserting SQL strings, write an
   **integration characterization test** first (real Postgres via `tests/support`),
   green against the current raw SQL. This is the TDD anchor.
3. **Swap internals to Kysely**, method by method:
   - Replace `db.queryOne/queryOptional/query/execute(sql, params)` with Kysely builders
     against the generated `DB` type.
   - Keep the `*Row` → `*Record` mapper; map from `Selectable<…>` results.
   - Use `sqlHelpers` for any pgvector/FTS/JSONB/locking/`SET LOCAL` fragment — never an
     inline `sql` tag in the repository.
   - For transactions, accept `Db = Kysely<DB> | Transaction<DB>` and use
     `db.transaction().execute(trx => …)` at the orchestration boundary.
4. **Run the tests** — they must pass unchanged (behavior preserved).
5. **Type-check**: `pnpm --dir backend exec tsc -p tsconfig.json --noEmit` — a wrong
   column name must now fail here.
6. **Commit** the single repository (`refactor(db): migrate <repo> to Kysely`).

## Verifying behavior parity (US3 retrieval)

For vector/lexical search, parity is exact:

```bash
cd backend && pnpm exec vitest run tests/integration/retrieval.integration.test.ts
```

Assert identical chunk IDs, ordering, and scores versus a captured raw-SQL baseline for
a fixed corpus + query set. Spot-check that the same indexes are used:

```sql
EXPLAIN ANALYZE <the generated query>;   -- confirm hnsw/ivfflat + GIN index usage
```

## Done-criteria for the whole feature

- `pnpm --dir backend run lint:boundaries` reports zero raw-SQL violations outside the
  runner and `sqlHelpers`.
- `pnpm --dir backend test` (unit + integration + contract) is green.
- `pnpm --dir backend run db:types:check` passes.
- `backend/src/db/repositories/README.md` and `docs/architecture/code-map.md` describe
  the Kysely convention with a worked example.
