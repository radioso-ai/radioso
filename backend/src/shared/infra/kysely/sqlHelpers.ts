import { sql, type Expression, type RawBuilder } from "kysely";

/**
 * Typed Postgres-specific SQL fragments.
 *
 * This is the **only** place in application code (besides the migration runner) where
 * raw SQL lives. Kysely's builder covers ordinary queries; everything Postgres-specific
 * that the builder can't express — pgvector distance/casts, full-text predicates and
 * ranking, JSONB operators, row-lock clauses, session settings — is expressed here as a
 * small, individually-tested `sql` fragment and imported by repositories. Keeping these
 * centralized makes the escape hatch auditable (the boundary lint allowlists this file)
 * and prevents `sql` tags from sprawling across ~40 repositories.
 *
 * Helpers are added alongside the first repository that needs them (vector/full-text
 * helpers land with the retrieval migration). Each helper ships with a focused test
 * asserting its compiled SQL.
 */

/**
 * `SET LOCAL <name> = <value>` — a session setting scoped to the current transaction.
 * Must run inside a transaction (e.g. `db.transaction().execute(...)`) on the same
 * connection as the statements it affects, mirroring how the migration runner and the
 * pgvector index-scan hint use it. `name` and `value` are emitted as raw identifiers/
 * literals, so they must be trusted constants, never user input.
 */
export const setLocal = (name: string, value: string): RawBuilder<unknown> =>
  sql`set local ${sql.raw(name)} = ${sql.raw(value)}`;

/**
 * `<expression> = ANY(<values>::<pgArrayType>)` — array membership, the Kysely-typed
 * equivalent of the raw `col = ANY($1::uuid[])` pattern. `pgArrayType` is a trusted
 * constant such as `"uuid[]"` or `"text[]"`.
 */
export const anyOf = (
  expression: Expression<unknown>,
  values: readonly unknown[],
  pgArrayType: string,
): RawBuilder<boolean> => sql`${expression} = any(${sql.val(values)}::${sql.raw(pgArrayType)})`;
