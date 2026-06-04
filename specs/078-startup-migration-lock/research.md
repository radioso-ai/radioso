# Research: Startup Migration Lock Reliability

## Decision: Use SELECT-first metadata table detection

**Rationale**: `listPendingMigrations` already uses `SELECT to_regclass('public.schema_migrations')` before reading the metadata table. Reusing this shape for `runMigrations` lets steady-state startup avoid `CREATE TABLE IF NOT EXISTS schema_migrations`, which is the DDL lock attempt that caused the incident.

**Alternatives considered**:

- Always run `CREATE TABLE IF NOT EXISTS`: rejected because it preserves the steady-state DDL lock risk.
- Move migrations to a pre-deploy job immediately: rejected for this feature because it expands deployment architecture beyond the approved incident fix.

## Decision: Add migration-specific timeout budgets on the migration connection

**Rationale**: Generic app database timeouts already exist, but startup migration metadata checks have a distinct platform reliability requirement: they must fail well before the startup probe window when blocked by stale metadata-table locks. A migration lock timeout and statement timeout make blocked metadata access visible as application errors.

Migration SQL bodies disable those local metadata timeouts inside the transaction. Large index builds, table rewrites, and backfills must remain able to finish instead of being converted into repeated deploy failures.

**Alternatives considered**:

- Rely on platform startup probes: rejected because this is the silent failure mode.
- Reuse only global app query timeouts: rejected because app query budgets may be tuned for request/runtime behavior and do not clearly express migration startup risk.

## Decision: Keep API port binding after successful migrations

**Rationale**: Binding before migrations would make the service appear healthy against a possibly incompatible schema. The approved scope is to make migration startup bounded and observable, not to weaken startup readiness.

**Alternatives considered**:

- Bind HTTP first and run migrations in the background: rejected because it can serve traffic before required schema changes exist.

## Decision: Keep workers as pending-migration verifiers

**Rationale**: The incident notes worker cold-starts succeeded because workers use SELECT-only pending-migration checks. Preserving this split keeps schema changes owned by the backend and prevents document processing against a stale schema.

**Alternatives considered**:

- Let workers apply migrations too: rejected because multiple runtime classes would compete to mutate schema and increase rollout risk.

## Decision: Update operator docs, not AGENTS.md

**Rationale**: Deployment behavior and incident diagnostics are product/operator surface. Durable operator docs are the right place for migration startup ownership, failure signals, and lock diagnostics. `AGENTS.md` should remain concise and not contain incident-specific run logs.

**Alternatives considered**:

- Add incident notes to `AGENTS.md`: rejected by repo maintenance rules.
