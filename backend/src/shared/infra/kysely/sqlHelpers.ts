import { sql, type Expression, type RawBuilder } from "kysely";

import type { JsonValue } from "./schema.js";
import type { Db } from "./types.js";

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
 * Serialize a value as `jsonb`. node-postgres serializes a plain JS object to JSON for a
 * json/jsonb column, but a JS **array** is sent as a Postgres array literal (→ "invalid
 * input syntax for type json"). Stringifying and casting with `::jsonb` is unambiguous for
 * both objects and arrays. Use for every jsonb write value.
 */
export const toJsonb = (value: unknown): RawBuilder<JsonValue> => sql`${JSON.stringify(value)}::jsonb`;

/**
 * jsonb `->> key` — extract a top-level key as text (NULL if absent). Use as a comparison
 * operand, e.g. `.where(jsonbKeyText(eb.ref("metadata_json"), "conversationId"), "=", id)`.
 */
export const jsonbKeyText = (column: Expression<unknown>, key: string): RawBuilder<string | null> =>
  sql`${column} ->> ${key}`;

/**
 * `jsonb_set(coalesce(<column>, '{}'), '{<path>}', <value>, true)` — set/replace a nested
 * key, creating missing parents. `path` is a trusted key sequence; `value` is `toJsonb(...)`.
 */
export const jsonbSet = (
  column: Expression<unknown>,
  path: readonly string[],
  value: Expression<unknown>,
): RawBuilder<JsonValue> =>
  sql`jsonb_set(coalesce(${column}, '{}'::jsonb), ${sql.lit(`{${path.join(",")}}`)}, ${value}, true)`;

/** `<expression>::text` — cast to text (e.g. to compare a uuid column against an arbitrary string). */
export const castText = (expr: Expression<unknown>): RawBuilder<string> => sql`${expr}::text`;

/**
 * jsonb `||` concatenation (shallow merge), e.g. `config || '{...}'::jsonb`. Right-hand keys
 * win, matching the raw `config = config || EXCLUDED.config` merge pattern. Pass `toJsonb(obj)`
 * for the right operand and `eb.ref("col")` for the existing column.
 */
export const jsonbConcat = (
  left: Expression<unknown>,
  right: Expression<unknown>,
): RawBuilder<JsonValue> => sql`${left} || ${right}`;

/**
 * `now()` — the Postgres transaction clock, for `created_at` / `updated_at` writes that
 * must use the database clock (not the app clock) to match the original raw SQL and stay
 * consistent across rows written in one statement. Prefer this over `new Date()` for
 * server-set timestamps.
 */
export const currentTimestamp = (): RawBuilder<Date> => sql`now()`;

/**
 * `clock_timestamp()` — the wall clock read fresh on each call (unlike `now()`, which is
 * fixed for the whole transaction). Used where rows inserted within one transaction must
 * get strictly increasing timestamps (e.g. message ordering). Do not substitute `now()`.
 */
export const clockTimestamp = (): RawBuilder<Date> => sql`clock_timestamp()`;

/** `now() - make_interval(secs => <seconds>)` — a timestamp `seconds` in the past (DB clock). */
export const nowMinusSeconds = (seconds: number): RawBuilder<Date> =>
  sql`now() - make_interval(secs => ${seconds})`;

/** `now() + make_interval(secs => <seconds>)` — a timestamp `seconds` in the future (DB clock). */
export const nowPlusSeconds = (seconds: number): RawBuilder<Date> =>
  sql`now() + make_interval(secs => ${seconds})`;

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
 * Whether a table (or other relation) currently exists, via `to_regclass`. Mirrors the
 * defensive guard some repositories use before querying a table that may be absent in a
 * partially-migrated schema (returns NULL rather than erroring on a missing relation).
 * `name` is a trusted constant, never user input.
 */
export const tableExists = async (db: Db, name: string): Promise<boolean> => {
  const result = await sql<{ reg: string | null }>`select to_regclass(${name}) as reg`.execute(db);
  return (result.rows[0]?.reg ?? null) !== null;
};

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
