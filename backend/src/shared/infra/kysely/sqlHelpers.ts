import { randomUUID } from "node:crypto";

import { sql, type Expression, type RawBuilder } from "kysely";

import { stringifyJsonb } from "../jsonb.js";
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
 * Serialize arbitrary text-bearing payloads as `jsonb`, preserving the repository-wide
 * sanitization for NUL bytes and lone surrogates before Postgres sees the value.
 */
export const toSanitizedJsonb = (value: unknown): RawBuilder<JsonValue> => sql`${stringifyJsonb(value)}::jsonb`;

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
 * Transaction-scoped advisory lock for a stable text key. Callers use this to
 * serialize a short get-or-create transaction without holding application data
 * in the lock key. PostgreSQL releases the lock automatically at transaction end.
 */
export const transactionAdvisoryLock = (key: string): RawBuilder<unknown> =>
  sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;

/**
 * Session-level advisory lock statements for adapters that must hold one lock
 * on one pinned database connection across calls. The lock key is always bound
 * as a parameter; callers must unlock on the same connection that acquired it.
 */
export const sessionAdvisoryLock = (key: string): RawBuilder<unknown> =>
  sql`select pg_advisory_lock(hashtextextended(${key}, 0))`;

export const trySessionAdvisoryLock = (key: string): RawBuilder<{ acquired: boolean }> =>
  sql<{ acquired: boolean }>`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as acquired`;

export const sessionAdvisoryUnlock = (key: string): RawBuilder<{ released: boolean }> =>
  sql<{ released: boolean }>`select pg_advisory_unlock(hashtextextended(${key}, 0)) as released`;

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

/** Validate and serialize one dynamic-width pgvector value without exposing raw SQL to repositories. */
export const serializePgVector = (values: readonly number[]): string => {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("A pgvector value must contain finite dimensions");
  }
  return `[${values.join(",")}]`;
};

/** Bound parameter cast to pgvector's dynamic-width `vector` type. */
export const toPgVector = (values: readonly number[]): RawBuilder<string> =>
  sql`${serializePgVector(values)}::vector`;

/** pgvector cosine distance (`0` is identical, `2` is opposite). */
export const pgVectorCosineDistance = (
  column: Expression<unknown>,
  values: readonly number[],
): RawBuilder<number> => sql<number>`(${column} <=> ${toPgVector(values)})`;

/** Mean of dynamic-width pgvector values, used for bounded aggregate reconciliation. */
export const pgVectorAverage = (column: Expression<unknown>): RawBuilder<string | null> =>
  sql<string | null>`avg(${column})`;

/**
 * Common claim validation and token construction for `FOR UPDATE SKIP LOCKED`
 * repositories. The caller still owns the transaction and state predicates.
 */
export const createClaimLease = (input: {
  now: Date;
  leaseMs: number;
  limit: number;
  maxLimit: number;
}): { token: string; expiresAt: Date } => {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > input.maxLimit) {
    throw new Error(`Claim limit must be between 1 and ${input.maxLimit}`);
  }
  if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1) {
    throw new Error("Claim lease must be a positive integer number of milliseconds");
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new Error("Claim time must be valid");
  }
  return {
    token: randomUUID(),
    expiresAt: new Date(input.now.getTime() + input.leaseMs),
  };
};
