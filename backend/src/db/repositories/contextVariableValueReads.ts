/**
 * The context-variable repository's reads of stored values, and the value row they map, which the
 * repository's value writer returns too.
 */

import type {
  ContextValueWriterKind,
  ContextVariableScope,
  ContextVariableValue,
} from "../../modules/context-variables/public.js";
import { sql } from "kysely";

import { anyOf } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

interface ContextVariableValueRow {
  id: string;
  workspace_id: string;
  variable_id: string;
  scope_type: string;
  scope_id: string;
  data: unknown;
  last_modified: Date | string;
  written_by_kind: string;
  written_by_ref: string | null;
}

export const contextVariableValueColumns = [
  "id",
  "workspace_id",
  "variable_id",
  "scope_type",
  "scope_id",
  "data",
  "last_modified",
  "written_by_kind",
  "written_by_ref",
] as const;

/**
 * The predicate of the Inbox filter's partial index, `idx_context_variable_values_variable_scope_data`
 * (migration 271), word for word. Postgres serves a query from a partial index only when the query's
 * WHERE implies the index's, and it cannot derive this from `data = $1`, so a read that filters
 * values by an enum key carries it to be served by the index. Every enum key satisfies it: a string
 * of at most `maxKeyChars` (120) ASCII characters.
 */
export const filterIndexPredicate = sql<boolean>`jsonb_typeof(data) = 'string' and octet_length(data #>> '{}') <= 120`;

/**
 * The scope id as a value is stored under. A conversation's id is a UUID, which Postgres writes in
 * lowercase, so an id sent in uppercase still names the stored value.
 */
export const storedScopeId = (scope: ContextVariableScope): string =>
  scope.type === "conversation" ? scope.id.toLowerCase() : scope.id;

export const mapContextVariableValueRow = (row: ContextVariableValueRow): ContextVariableValue => ({
  id: row.id,
  workspaceId: row.workspace_id,
  variableId: row.variable_id,
  scope: {
    type: row.scope_type as ContextVariableScope["type"],
    id: row.scope_id,
  },
  data: row.data,
  lastModified: new Date(row.last_modified),
  writtenBy: { kind: row.written_by_kind as ContextValueWriterKind, ref: row.written_by_ref },
});

export const readContextVariableValue = async (
  db: Db,
  variableId: string,
  scope: ContextVariableScope,
): Promise<ContextVariableValue | null> => {
  const row = await db
    .selectFrom("context_variable_values")
    .select(contextVariableValueColumns)
    .where("variable_id", "=", variableId)
    .where("scope_type", "=", scope.type)
    .where("scope_id", "=", storedScopeId(scope))
    .executeTakeFirst();
  return row ? mapContextVariableValueRow(row) : null;
};

/**
 * Each variable's most specific stored value on the ladder, in one read. `scopes` is the ladder,
 * most specific first; a variable no rung holds a value for is absent from the result.
 */
export const readMostSpecificValues = async (
  db: Db,
  variableIds: readonly string[],
  scopes: readonly ContextVariableScope[],
): Promise<Map<string, ContextVariableValue>> => {
  if (variableIds.length === 0 || scopes.length === 0) return new Map();
  const rung = sql<number>`case ${sql.join(scopes.map((scope, index) =>
    sql`when scope_type = ${scope.type} and scope_id = ${storedScopeId(scope)} then ${index}`), sql` `)} end`;
  const rows = await db
    .selectFrom("context_variable_values")
    .distinctOn("variable_id")
    .select(contextVariableValueColumns)
    .where((eb) => anyOf(eb.ref("variable_id"), variableIds, "uuid[]"))
    .where((eb) => eb.or(scopes.map((scope) => eb.and([
      eb("scope_type", "=", scope.type),
      eb("scope_id", "=", storedScopeId(scope)),
    ]))))
    .orderBy("variable_id")
    .orderBy(rung)
    .execute();
  return new Map(rows.map((row) => [row.variable_id, mapContextVariableValueRow(row)]));
};

/** Every stored value of the variables on any rung of the ladder, in one read; a rung that holds none adds nothing. */
export const readLadderValues = async (
  db: Db,
  variableIds: readonly string[],
  scopes: readonly ContextVariableScope[],
): Promise<ContextVariableValue[]> => {
  if (variableIds.length === 0 || scopes.length === 0) return [];
  const rows = await db
    .selectFrom("context_variable_values")
    .select(contextVariableValueColumns)
    .where((eb) => anyOf(eb.ref("variable_id"), variableIds, "uuid[]"))
    .where((eb) => eb.or(scopes.map((scope) => eb.and([
      eb("scope_type", "=", scope.type),
      eb("scope_id", "=", storedScopeId(scope)),
    ]))))
    .execute();
  return rows.map(mapContextVariableValueRow);
};
