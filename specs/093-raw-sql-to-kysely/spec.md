# Feature Specification: Migrate Backend Data Access from Raw SQL to Kysely

**Feature Branch**: `093-raw-sql-to-kysely`
**Created**: 2026-06-21
**Status**: Draft
**Input**: User description: "do a comprehensive spec-plan-tasks cycle for moving from raw sql to kysely"

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are **backend engineers** who write and maintain data
access code, and **operators** who depend on the backend continuing to behave
identically after the change. Every story below is a refactor slice: it changes
*how* persistence code is written, never *what* the application does at runtime.

### User Story 1 - Kysely foundation with a reference repository (Priority: P1) 🎯 MVP

A backend engineer can write a repository's persistence code with the Kysely query
builder against a generated, type-checked database schema instead of hand-written SQL
strings, and the application behaves exactly as before. One representative repository
is fully migrated end-to-end to prove the seam, the type-generation pipeline, the
transaction story, and the test approach.

**Why this priority**: Nothing else can proceed until the foundation exists — the
typed schema, the Kysely instance built on the shared connection pool, the
escape-hatch helpers for Postgres-specific features, and a worked reference that
later repositories copy. Shipping this alone already delivers value: it establishes
the pattern and lets new persistence code be written type-safely.

**Independent Test**: Migrate one simple repository (e.g. `sessionRepository` or
`workspaceTokenRepository`) to Kysely; run that repository's existing unit and
integration tests unchanged and confirm they pass; confirm the generated schema type
file is produced by a repeatable command and is in sync with the migrations.

**Acceptance Scenarios**:

1. **Given** the current backend, **When** an engineer runs the type-generation
   command, **Then** a committed, type-checked database schema definition is produced
   from the existing migrations with no hand-editing required.
2. **Given** the reference repository migrated to Kysely, **When** its existing tests
   run, **Then** they pass without changes to the repository's public port (interface)
   or to its callers.
3. **Given** a query that references a non-existent column, **When** the engineer
   compiles the backend, **Then** the type checker rejects it (a guarantee raw SQL
   strings did not provide).
4. **Given** a repository method that runs inside a transaction today, **When** it is
   migrated, **Then** the same atomic behavior holds (commit on success, rollback on
   error) using the Kysely transaction mechanism.

---

### User Story 2 - Migrate the CRUD repositories (Priority: P2)

A backend engineer migrates the straightforward create/read/update/delete
repositories — those whose statements are simple selects, inserts, updates, deletes,
upserts (`ON CONFLICT`), `RETURNING` clauses, and array membership filters — to
Kysely, one repository at a time, with each repository's tests staying green.

**Why this priority**: This is the bulk of the surface (~30 of ~40 repositories) and
the lowest-risk portion. It can be delivered incrementally; each repository is an
independent, shippable unit because its port is unchanged.

**Independent Test**: For any repository in this group, migrate it in isolation and
run its existing tests plus the integration suite; the rest of the system is
untouched and unaware of the change.

**Acceptance Scenarios**:

1. **Given** a CRUD repository migrated to Kysely, **When** its callers invoke it,
   **Then** they receive identical domain records (same fields, types, and ordering)
   as before.
2. **Given** an upsert repository, **When** a conflicting row is written, **Then** the
   conflict resolution (update or do-nothing) matches the prior behavior exactly.
3. **Given** a repository using array-membership filtering, **When** queried with a
   list of identifiers, **Then** the returned rows match the prior `ANY(...)` behavior.

---

### User Story 3 - Migrate complex repositories and module-level SQL (Priority: P3)

A backend engineer migrates the high-complexity persistence code: aggregate/`LATERAL`
composition repositories, worker job-claim repositories that use row-level locking,
the dynamic query builders in reporting and quality triage, and the retrieval
infrastructure (vector similarity and full-text search). Postgres-specific operators
are expressed through a single, well-tested set of typed SQL-fragment helpers.

**Why this priority**: Highest risk and the most Postgres-specific behavior
(pgvector distance operators, `tsvector`/`tsquery` full-text search, `FOR UPDATE SKIP
LOCKED`, advisory/session settings, `json_agg`/`LATERAL` shaping). It is done last,
after the foundation and the simpler repositories have proven the pattern, and with
the most verification.

**Independent Test**: Migrate one complex area (e.g. retrieval vector search) and run
its integration tests against a real Postgres with pgvector; confirm result ordering
and scores are unchanged versus the raw-SQL baseline.

**Acceptance Scenarios**:

1. **Given** vector similarity search migrated to Kysely, **When** the same query
   embedding is searched, **Then** the same chunks are returned in the same ranked
   order with the same distances as the raw-SQL implementation.
2. **Given** full-text/lexical search migrated to Kysely, **When** the same query
   text is searched, **Then** the same matches and ranking scores are produced.
3. **Given** a worker job-claim repository migrated to Kysely, **When** multiple
   workers contend for jobs concurrently, **Then** each job is claimed exactly once
   (the `FOR UPDATE SKIP LOCKED` guarantee is preserved).
4. **Given** the dynamic reporting/quality query builders migrated to Kysely, **When**
   queried with every combination of optional filters, **Then** results match the
   prior dynamically-assembled SQL.

---

### User Story 4 - Lock in the new convention (Priority: P3)

A backend engineer is prevented from reintroducing raw SQL query strings in
application code: a boundary/lint guard fails the build when raw query strings appear
outside the explicitly allowed locations (the migration runner and the typed
SQL-fragment helpers), and the documentation describes Kysely as the canonical way to
write persistence code.

**Why this priority**: Without enforcement and updated docs, the codebase will drift
back to raw SQL. This story makes the migration durable but depends on the bulk of the
migration being complete first.

**Independent Test**: Add a forbidden raw query string to a repository and confirm the
guard fails; remove it and confirm the guard passes; confirm the repositories README
and code-map describe the Kysely convention.

**Acceptance Scenarios**:

1. **Given** the guard is in place, **When** a developer adds a raw `.query("SELECT
   ...")` string to a repository or module, **Then** the lint/boundary check fails with
   a clear message pointing to the allowed alternatives.
2. **Given** the migration runner and the typed SQL-fragment helpers, **When** the
   guard runs, **Then** those allowed locations are not flagged.
3. **Given** the updated documentation, **When** an engineer reads the repositories
   README, **Then** it shows a Kysely worked example as the canonical pattern.

### Edge Cases

- **Migration runner**: schema migrations remain raw `.sql` files executed by the
  migration runner. This is intentional and explicitly out of scope; the runner keeps
  its raw execution path.
- **pgvector serialization**: embedding values are serialized as bracketed vector
  literals and cast to `vector`/`vector(1536)`; the migration must preserve this exact
  serialization and the bounded/unbounded column selection.
- **Bounded vs unbounded embeddings**: vector search chooses the embedding column
  based on query dimensionality; this branch must be preserved.
- **BIGINT / numeric coercion**: columns returned as strings by the driver (byte
  counts, token sums) must still be coerced identically in the row mappers.
- **Cursor pagination tuple comparison**: keyset pagination uses tuple comparison
  (`col1 < $1 OR (col1 = $1 AND col2 < $2)`); the equivalent must produce identical
  page boundaries.
- **Session-scoped settings**: statements that issue `SET LOCAL` (e.g. vector index
  scan hints, disabled timeouts) must run on the same connection as the query they
  affect.
- **Generated-types drift**: if a migration changes the schema but the generated types
  are not regenerated, the check command must fail in CI.
- **Mixed state during rollout**: while migration is in progress, raw-SQL and Kysely
  repositories coexist on the same pool and inside the same transactions; both must
  interoperate.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
  (This feature is backend-only; no frontend change.)
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search. Kysely
  MUST express pgvector and full-text operations through typed SQL fragments; it MUST
  NOT replace, hide, or weaken pgvector usage.
- LLM integrations are unaffected by this change.
- No user-facing assistant or chat copy is introduced; this is a persistence refactor.
- Backend development MUST follow TDD: because behavior must be preserved exactly, each
  repository's existing tests are the specification. Where coverage is thin, characterization
  tests MUST be written against the raw-SQL implementation first (and pass), then the
  implementation is swapped to Kysely and the same tests MUST still pass.
- Secrets and keys MUST be stored in `.env`; this change adds no new secrets.
- Customer data MUST be protected with least-privilege access and secure transmission;
  the connection pool, credentials, and access paths are unchanged.
- Features MUST preserve modular boundaries between transport, orchestration, domain
  logic, and persistence. Domain modules continue to depend only on repository ports.
- Specs MUST identify files or modules that should remain responsibility-limited: the
  generated schema file is generated-only (never hand-edited); domain records never
  import Kysely or the generated schema types.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport (`app/http`) and orchestration (`modules/*/services`)
  are untouched. Domain modules keep depending on `*RepositoryPort` interfaces.
  Persistence adapters (`db/repositories/*`, `modules/*/infra/*`) change their
  internals from raw SQL to Kysely. Connection-pool lifecycle stays in
  `shared/infra/database.ts`.
- **Encapsulation Rule**: The generated database-schema type file is generated-only and
  must never be hand-edited. Domain record types (`*Record`) must not reference Kysely
  or the generated schema. Postgres-specific SQL fragments must live in a single typed
  helpers module, not be scattered as inline `sql` tags across repositories.
- **New Seams Required**:
  - A typed Kysely database instance built on the existing `pg` pool.
  - A generated database-schema type definition produced from the migrations.
  - A typed SQL-fragment helpers module for pgvector, full-text search, JSONB
    operators, row-locking, and session settings.
  - A transaction-propagation convention so a Kysely transaction can be threaded
    through repositories that participate in multi-statement atomic operations.
  - A type-generation command (and a CI check command) mirroring the existing schema
    dump tooling.
- **Anti-Goals**:
  - Do NOT adopt Kysely's migration system; schema migrations remain raw `.sql` files.
  - Do NOT change any `*RepositoryPort` interface, domain record shape, HTTP contract,
    SDK contract, MCP contract, or worker payload as part of this migration.
  - Do NOT hand-edit the generated schema types.
  - Do NOT scatter raw `sql` fragments across repositories; centralize them.
  - Do NOT introduce an ORM, entity classes, or a unit-of-work pattern.
  - Do NOT change query behavior, result ordering, or pagination semantics "while we're
    in there"; behavior changes are separate work.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a typed Kysely database instance constructed on
  the existing shared `pg` connection pool, so Kysely and any remaining raw paths share
  one pool and one transaction context.
- **FR-002**: The system MUST generate a type-checked database-schema definition from
  the existing migrations via a repeatable command, and the generated file MUST be
  committed and treated as generated output (never hand-edited).
- **FR-003**: The system MUST provide a CI check command that fails when the committed
  generated schema is out of sync with the migrations.
- **FR-004**: Repository adapters MUST be migrated from raw SQL strings to Kysely while
  keeping their public ports, callers, and returned domain records unchanged.
- **FR-005**: The system MUST preserve transactional semantics: multi-statement atomic
  operations MUST commit on success and roll back on error, with a Kysely transaction
  threaded through all participating repositories.
- **FR-006**: The system MUST express pgvector operations (distance operators, vector
  casts, dimension inspection, index-scan session settings) through typed SQL-fragment
  helpers, preserving exact behavior and result ordering.
- **FR-007**: The system MUST express full-text/lexical search (`to_tsvector`,
  `plainto_tsquery`/`phraseto_tsquery`, `@@`, `ts_rank_cd`) through typed SQL-fragment
  helpers, preserving exact matches and ranking scores.
- **FR-008**: The system MUST preserve upsert behavior (`ON CONFLICT ... DO
  UPDATE`/`DO NOTHING`, including partial-index conflict targets) exactly.
- **FR-009**: The system MUST preserve worker job-claim semantics, including
  `FOR UPDATE SKIP LOCKED`, so each job is claimed at most once under concurrency.
- **FR-010**: The system MUST preserve dynamic/conditional query construction (reporting
  trends, quality triage filters, chunk filters) so every combination of optional
  filters yields identical results to the raw-SQL builders.
- **FR-011**: The system MUST preserve cursor/keyset pagination boundaries and ordering.
- **FR-012**: The system MUST keep the `*Row` (snake_case) → `*Record` (camelCase)
  mapping convention; domain records MUST NOT leak database column names or Kysely
  types.
- **FR-013**: Schema migrations MUST remain raw `.sql` files executed by the existing
  migration runner; the migration runner is out of scope for the Kysely migration.
- **FR-014**: After the bulk migration, the system MUST enforce — via the existing
  boundary/lint tooling — that raw SQL query strings do not appear in application code
  outside the migration runner and the typed SQL-fragment helpers.
- **FR-015**: Documentation (repositories README, architecture code-map, and any
  relevant briefs) MUST be updated to describe Kysely as the canonical persistence
  approach, with a worked example.
- **FR-016**: Each migrated repository MUST be covered by passing unit and/or
  integration tests; where existing coverage is insufficient to guarantee behavior
  preservation, characterization tests MUST be added against the raw-SQL implementation
  before the swap.

### Key Entities *(include if feature involves data)*

- **Generated database schema**: A type definition describing every table and column,
  produced from the migrations by introspection. Generated output; the compile-time
  contract repositories build queries against.
- **Kysely database instance**: The query-builder handle bound to the shared pool;
  injected into repositories the same way the current `Database` is.
- **Typed SQL-fragment helpers**: The single module that owns Postgres-specific
  expressions (vector distance, full-text predicates/ranking, JSONB operators, row
  locking, session settings) as typed, reusable fragments.
- **Repository adapter**: An implementation of a persistence port; its internals change
  from raw SQL to Kysely, its port and domain records do not.
- **Domain record (`*Record`)**: The camelCase boundary type returned to domain
  modules; unchanged by this migration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the existing backend test suite (unit, integration, contract)
  passes after each migration slice, with no changes to test assertions about
  application behavior.
- **SC-002**: Zero raw SQL query strings remain in application persistence code outside
  the two allowed locations (migration runner and typed SQL-fragment helpers), verified
  by the boundary/lint guard returning zero violations.
- **SC-003**: A query referencing a non-existent column or table fails at compile time
  in 100% of cases (demonstrated by at least one deliberate negative compile test),
  whereas the same mistake was previously a runtime error.
- **SC-004**: Retrieval result parity is exact: for a fixed corpus and query set, vector
  and lexical search return identical result sets, ordering, and scores before and after
  migration.
- **SC-005**: No measurable runtime regression: representative query latency (retrieval
  search, conversation listing, document listing) stays within 5% of the raw-SQL
  baseline at p95.
- **SC-006**: The generated schema stays in sync with migrations: the sync-check command
  passes in CI, and intentionally desynchronizing it (changing a migration without
  regenerating) makes the check fail.
- **SC-007**: Every repository and module-level SQL site identified in the inventory is
  either migrated to Kysely or explicitly recorded as an allowed raw-SQL exception with
  a documented reason.
