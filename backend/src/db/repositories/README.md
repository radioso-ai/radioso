# Data access (repositories)

This directory holds the Postgres implementations of the persistence **ports** that
domain modules depend on. It is the canonical place SQL lives in the backend.

## The shape (and why)

Radioso has no ORM. Data access follows ports-and-adapters:

```
modules/<area>/...            ← domain logic, depends on a PORT (an interface)
  └─ defines  FooRepositoryPort
db/repositories/fooRepository.ts   ← ADAPTER: implements the port, owns the SQL
db/repositories/fooRowMapper.ts    ← maps DB rows (snake_case) → domain records (camelCase)
db/migrations/NNN_*.sql            ← the schema; system of record
app/server/dependencyBuilders.ts   ← COMPOSITION: wires the concrete repo to the port
```

Rules that keep this clean:

- **Domain depends on the port, never on Postgres.** A module imports
  `FooRepositoryPort` (a type); it does not import `pg`, the `Database` class, or a
  concrete repository. The dependency points *into* the domain, not out to infra.
- **Query-building lives in the adapter, not in domain code.** Adapters build queries
  with the Kysely query builder, typed against the generated schema
  (`shared/infra/kysely/schema.ts`). Query-building inside a service/route handler is the
  smell — that's a missing port. Raw SQL strings belong only in migrations and in the
  centralized `shared/infra/kysely/sqlHelpers.ts`; never hand-write SQL in a repository.
- **Rows are not domain objects.** A `*Row` interface describes DB columns; a mapper
  converts it to the domain record. Keep DB column names (`snake_case`) out of the
  domain.
- **Postgres is the system of record.** Schema changes are migration files (see
  below), never ad-hoc DDL.

See the project-wide rationale in `../../../../docs/architecture/code-map.md` and the
"Application composition owns replaceable runtime wiring" decision in the root
`CLAUDE.md`.

## Worked example: adding a new entity

Suppose you're adding a `Widget` entity. The canonical reference to copy is
`sessionRepository.ts` (a minimal Kysely adapter). A minimal version:

### 1. Migration — define the schema (system of record)

Create the next-numbered file in `../migrations/` (e.g. `102_widgets.sql`). Migrations
run in filename order at startup. Use `IF NOT EXISTS` only for drift tolerance, not as
a substitute for ordering:

```sql
CREATE TABLE widgets (
  id           UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_widgets_workspace ON widgets (workspace_id);
```

Then regenerate the schema snapshot (see "Schema snapshot" below).

### 2. Port — declare what the domain needs (in the module, not here)

In the owning module (e.g. `modules/widgets/contracts/` or its service), define the
narrow interface the domain consumes — only the methods it actually uses:

```ts
export interface WidgetRepositoryPort {
  create(input: WidgetCreateInput): Promise<WidgetRecord>;
  findByIdAndWorkspaceId(id: string, workspaceId: string): Promise<WidgetRecord | null>;
  listByWorkspaceId(workspaceId: string): Promise<WidgetRecord[]>;
}
```

(In this repo, `DocumentRepositoryPort` lives in
`modules/documents/services/documentIngestionService.ts` and is re-exported from
`modules/documents/contracts/index.ts`.)

### 3. Row + mapper — keep DB shape out of the domain

`widgetRowMapper.ts`:

```ts
export interface WidgetRow {
  id: string;
  workspace_id: string;
  name: string;
  created_at: Date;
}

// Reusable column tuple so select/returning lists don't drift between queries.
export const widgetColumns = ["id", "workspace_id", "name", "created_at"] as const;

export const mapWidget = (row: WidgetRow): WidgetRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  createdAt: new Date(row.created_at),
});
```

> Note: `BIGINT` columns arrive from `node-postgres` as **strings**. Coerce them in
> the mapper (see `coerceByteCount` in `documentRowMapper.ts`) — don't assume `number`.

### 4. Repository — the adapter that owns the SQL

Adapters use the **Kysely** query builder, typed against the generated schema
(`shared/infra/kysely/schema.ts`). The reference to copy for a simple repository is
`sessionRepository.ts`. `widgetRepository.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Db } from "../../shared/infra/kysely/types.js";
import { mapWidget, widgetColumns, type WidgetRow } from "./widgetRowMapper.js";

export class WidgetRepository implements WidgetRepositoryPort {
  // `Db` is `Kysely<DB> | Transaction<DB>` — the repo works standalone or inside a
  // caller's transaction. Composition injects `database.kysely`.
  constructor(private readonly db: Db) {}

  async create(input: WidgetCreateInput): Promise<WidgetRecord> {
    const row = await this.db
      .insertInto("widgets")
      .values({ id: randomUUID(), workspace_id: input.workspaceId, name: input.name })
      .returning(widgetColumns)
      .executeTakeFirstOrThrow();
    return mapWidget(row);
  }

  async findByIdAndWorkspaceId(id: string, workspaceId: string): Promise<WidgetRecord | null> {
    const row = await this.db
      .selectFrom("widgets")
      .select(widgetColumns)
      .where("id", "=", id)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? mapWidget(row) : null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<WidgetRecord[]> {
    const rows = await this.db
      .selectFrom("widgets")
      .select(widgetColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(mapWidget);
  }
}
```

where `widgetColumns` is the shared column tuple in the mapper
(`["id", "workspace_id", "name", "created_at"] as const`), so column lists don't drift.

Kysely is injected as `Db` (`shared/infra/kysely/types.ts`). For writes that span more
than one statement, use `db.transaction().execute(async (trx) => { ... })` and pass `trx`
to each participating repository so they share one transaction (Kysely `Transaction<DB>`
satisfies `Db`).

Postgres-specific SQL the builder can't express — pgvector distance/casts, full-text
predicates, JSONB operators, `FOR UPDATE SKIP LOCKED`, `SET LOCAL` — comes from typed
fragments in `shared/infra/kysely/sqlHelpers.ts`, the **only** place (besides migrations)
where raw SQL belongs. Don't inline `sql` tags in repositories; add a helper.

> Migration in progress: some repositories still take the raw `Database` and use
> `query` / `withTransaction`. New and migrated repositories use Kysely as above.

### 5. Composition — wire it once

In `app/server/dependencyBuilders.ts`, alongside the other repositories:

```ts
widgetRepository: new WidgetRepository(database.kysely),
```

Domain code receives `widgetRepository` typed as `WidgetRepositoryPort` — it never sees
the concrete class.

## Conventions checklist

- [ ] One repository per entity/aggregate; methods named for intent
      (`findByIdAndWorkspaceId`, not `select`).
- [ ] **Always scope by `workspace_id`** in tenant-owned queries.
- [ ] Build queries with Kysely against the generated schema; never hand-write SQL in a
      repository. Postgres-specific fragments come from `kysely/sqlHelpers.ts`.
- [ ] Share select/returning column lists via an exported `as const` tuple in the mapper.
- [ ] Map rows → records in the mapper; don't leak `*Row` or `DB` schema types out of
      this directory.
- [ ] Multi-statement writes go through `db.transaction().execute((trx) => ...)`, passing
      `trx` to each participating repository.
- [ ] Translate Postgres error codes (e.g. `23505` unique violation) to domain errors
      (`conflict`, `notFound`) — see `mapDocumentConflict` in `documentRepository.ts`.
- [ ] Tests: integration tests against a real Postgres
      (`tests/integration/...repository*.test.ts`), not mocks.

## Migrations

- Files live in `../migrations/`, named `NNN_description.sql`, applied in order by
  `../runMigrations.ts` at startup. Recorded in the `schema_migrations` table.
- Add a new migration; never edit an applied one.
- `001_init.sql` is also mounted as the Docker init script for the dev database.

## Schema snapshot

`../schema.sql` is a generated, read-only view of the **full resulting schema** — read
it to understand the database shape without replaying every migration. It is *not* the
system of record (the migrations are) and must not be hand-edited.

```bash
pnpm --dir backend run db:schema         # regenerate after adding a migration
pnpm --dir backend run db:schema:check   # fail if the snapshot is stale
```

The generator spins up its own throwaway `pgvector:pg16` container, applies every
migration in order, dumps the result, and tears the container down — so the snapshot
can never drift from the migrations, and behaves identically locally and in CI. The
only requirement is Docker; it does not touch the dev database or need the compose
stack running.

`db:schema:check` runs in CI (the backend integration job) and in `pnpm run ci:local`,
so a migration that changes the schema without a regenerated snapshot fails the build.
Regenerate and commit `schema.sql` in the same change as any migration.

## Schema types (Kysely)

`shared/infra/kysely/schema.ts` is the **generated TypeScript schema** Kysely queries are
typed against — one interface per table, derived from the migrations. Like the SQL
snapshot it is generated, read-only, and must not be hand-edited.

```bash
pnpm --dir backend run db:types         # regenerate after adding a migration
pnpm --dir backend run db:types:check   # fail if the generated types are stale
```

It uses the same throwaway `pgvector:pg16` container as `db:schema` (replays every
migration, then introspects with `kysely-codegen`), so the types can never drift from the
migrations. `vector`/`tsvector` columns map to `string` (the repositories serialize/parse
them); `BIGINT`/`NUMERIC` come back as strings. **Regenerate and commit `schema.ts` in the
same change as any migration**, the same way you do for `schema.sql`.
